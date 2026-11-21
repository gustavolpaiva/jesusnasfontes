import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Papel } from "./canario";
import { desabilitarNoCliente, habilitarNoCliente } from "./escritas-canario";
import { contarLinhasPrivadas, limparTudo } from "./limpeza-canario";
import { conferirContaCanario, emailDoCanario, RecusaCanario } from "./protecao-canario";
import { OutraExecucao, soltarTrava, tomarTrava, travaViva } from "./trava-canario";

// Uma EXECUÇÃO de teste com contas canário (plano 01-19). Três garantias, nesta ordem:
//
//   1. UMA execução por conta canário de cada vez: advisory lock tomado na preparação e solto depois da
//      limpeza (`trava-canario.ts`); outra execução recusa sem escrever.
//   2. A conta canário COMEÇA sem nenhuma linha privada (contagem pelo catálogo). Se tiver, aborta antes
//      de escrever e diz quantas: o que a conta tem ao fim é, por construção, desta execução.
//   3. A limpeza apaga TODAS as linhas privadas da conta, com teto, e confere zero. Só roda com a trava
//      ainda na mão, a proteção contra conta real conferida de novo (banco dev, endereço marcado, não é o
//      Admin inicial, papel certo) e a preparação autorizada E concluída.
//
// Toda conexão que escreve confere o marcador `dev` do banco antes (dentro de `conferirContaCanario`,
// `tomarTrava` e `limparTudo`, que recebem a própria conexão).
//
// A classe é FECHADA POR CONSTRUÇÃO: toda escrita (habilitar, sessão, limpeza, desabilitar) passa por um
// único método privado, `#escrever`, que confere a trava (retomando-a sem esperar se a conexão caiu), a
// proteção contra conta real e o id da conta ANTES de chamar a função de escrita; nenhum outro caminho
// recebe um cliente que escreve. Os métodos públicos que escrevem estão em `METODOS_QUE_ESCREVEM` e um
// teste prova que todos recusam sem a trava.

type Dono = Pick<pg.Client, "query">;
type Conexao = { cliente: Dono; fechar: () => Promise<void> };

// Registra um ouvinte de evento do cliente (pg.Client tem `on`; um cliente de teste pode não ter).
function ouvir(cliente: Dono, evento: "error" | "end", ouvinte: () => void): void {
  (cliente as { on?: (e: string, f: () => void) => unknown }).on?.(evento, ouvinte);
}

export type Fabrica = {
  /** Conexão do dono do banco (ignora a RLS), aberta e fechada a cada uso. */
  dono: () => Promise<Conexao>;
  /**
   * Conexão DEDICADA, direta e como dono do banco, mantida aberta até o fim da execução: é onde mora a
   * trava E por onde passa TODA escrita (sem conexão separada para escrever).
   */
  trava: () => Promise<Conexao>;
};

type Conta = { papel: Papel; email: string; usuarioId: string | null };

export class ExecucaoEncerrada extends RecusaCanario {
  override name = "ExecucaoEncerrada";
}

// Os ÚNICOS métodos públicos que escrevem. Um método público novo precisa entrar aqui (e no teste que
// prova que ele recusa sem a trava) ou o teste de enumeração reprova.
export const METODOS_QUE_ESCREVEM = [
  "preparar",
  "criarSessao",
  "encerrarSessao",
  "finalizar",
] as const;

// De USO ÚNICO: `preparar` roda uma vez e `finalizar` encerra a instância; qualquer chamada depois dela
// lança erro (estado velho de uma execução não pode autorizar escrita numa seguinte).
export class ExecucaoCanario {
  // A marca só entra nos textos que o teste escreve (para achá-los no Caderno e nos registros).
  readonly marca = randomUUID();
  #habilitados = new Map<Papel, Conta>();
  #sessoes: { id: string; usuarioId: string }[] = [];
  #preparado = false;
  #trava: Conexao | null = null;
  #travaPerdida = false;
  #travados: string[] = [];
  #iniciada = false;
  #encerrada = false;

  constructor(private readonly fabrica: Fabrica) {}

  get registro() {
    return {
      marca: this.marca,
      preparado: this.#preparado,
      habilitados: [...this.#habilitados.keys()],
      travados: this.#travados.length,
      travaPerdida: this.#travaPerdida,
      sessoes: this.#sessoes.map((s) => s.id),
    };
  }

  #exigirViva(): void {
    if (this.#encerrada) {
      throw new ExecucaoEncerrada("ExecucaoEncerrada: esta execução já foi finalizada; crie outra");
    }
  }

  // Conexão do dono para um uso, SÓ PARA LER (a proteção antes da trava). Nenhuma escrita passa por aqui.
  async #comDono<T>(fn: (c: Dono) => Promise<T>): Promise<T> {
    const { cliente, fechar } = await this.fabrica.dono();
    ouvir(cliente, "error", () => undefined);
    try {
      return await fn(cliente);
    } finally {
      await fechar().catch(() => undefined);
    }
  }

  // A conexão da trava: queda (erro ou fim) marca a trava como PERDIDA e nunca lança.
  #adotarTrava(t: Conexao): void {
    this.#trava = t;
    this.#travaPerdida = false;
    const perdeu = () => {
      if (this.#trava === t) this.#travaPerdida = true;
    };
    ouvir(t.cliente, "error", perdeu);
    ouvir(t.cliente, "end", perdeu);
  }

  // SEM a trava na mão, nenhuma escrita na conta canário (nem desabilitar). Confere que esta sessão ainda
  // segura todas as travas; se a conexão caiu, tenta retomá-las SEM esperar (`pg_try_advisory_lock`):
  // conseguindo, segue; outra execução com a conta, lança `OutraExecucao` e nada é escrito.
  async #garantirTrava(): Promise<void> {
    if (this.#travados.length === 0) return;
    const viva = async (): Promise<boolean> => {
      if (!this.#trava || this.#travaPerdida) return false;
      try {
        for (const email of this.#travados) {
          if (!(await travaViva(this.#trava.cliente, email))) return false;
        }
        return true;
      } catch {
        this.#travaPerdida = true;
        return false; // conexão derrubada
      }
    };
    if (await viva()) return;
    const velha = this.#trava;
    this.#trava = null;
    await velha?.fechar().catch(() => undefined);
    const nova = await this.fabrica.trava();
    ouvir(nova.cliente, "error", () => undefined);
    const tomadas: string[] = [];
    try {
      for (const email of this.#travados) {
        await tomarTrava(nova.cliente, email);
        tomadas.push(email);
      }
    } catch (erro) {
      for (const email of tomadas) await soltarTrava(nova.cliente, email).catch(() => undefined);
      await nova.fechar().catch(() => undefined);
      if (erro instanceof OutraExecucao) {
        throw new OutraExecucao(
          "OutraExecucao: a trava se perdeu e outra execução detém a conta canário; esta não escreveu nada.",
        );
      }
      throw erro;
    }
    this.#adotarTrava(nova);
  }

  // O ÚNICO caminho de escrita, e ele roda NA CONEXÃO QUE SEGURA A TRAVA: não há conexão separada para
  // escrever. Confere a trava (retomando-a se caiu), o banco dev, a proteção contra conta real e o id
  // da conta nessa mesma conexão e só então chama `fn` com ela. Se a conexão cair em qualquer ponto
  // depois da conferência, a escrita falha junto com a trava (a transação não chega ao commit).
  async #escrever<T>(conta: Conta, fn: (c: Dono) => Promise<T>): Promise<T> {
    await this.#garantirTrava();
    const cliente = (this.#trava as Conexao).cliente;
    const lido = await conferirContaCanario(cliente, conta.email, conta.papel);
    if (conta.usuarioId !== null && lido.usuarioId !== conta.usuarioId) {
      throw new RecusaCanario("RecusaDeConta: a conta canário não é mais a da preparação");
    }
    return fn(cliente);
  }

  // Conferências, trava e pré-condição ANTES de qualquer escrita; depois habilita cada conta.
  async preparar(papeis: Papel[]): Promise<void> {
    this.#exigirViva();
    if (this.#iniciada) {
      throw new ExecucaoEncerrada("ExecucaoEncerrada: preparar roda uma vez por execução");
    }
    this.#iniciada = true;
    this.#preparado = false;
    const ordenados = [...papeis].sort();
    const emails = new Map<Papel, string>();
    for (const papel of ordenados) {
      const email = emailDoCanario(papel);
      if (!email) throw new RecusaCanario(`INDETERMINADO: o canário ${papel} não está no ambiente`);
      emails.set(papel, email);
    }
    // 1. A proteção contra conta real, para todas as contas, antes de qualquer outra coisa. Aqui NADA
    //    decide a pré-condição: o id e a existência da conta só valem lidos com a trava na mão.
    await this.#comDono(async (dono) => {
      for (const papel of ordenados) {
        await conferirContaCanario(dono, emails.get(papel) as string, papel);
      }
    });
    // 2. A trava de cada conta (uma execução por vez), em ordem fixa.
    const conexao = await this.fabrica.trava();
    this.#adotarTrava(conexao);
    const cliente = conexao.cliente;
    for (const papel of ordenados) {
      const email = emails.get(papel) as string;
      await tomarTrava(cliente, email);
      this.#travados.push(email);
    }
    // 3. COM a trava, na MESMA conexão: o id (e se a conta existe) e a contagem pelo catálogo. A conta
    //    começa vazia; conta inexistente tem zero linhas; com linha prévia, aborta antes de escrever.
    const exigirVazia = async (papel: Papel, email: string): Promise<string | null> => {
      const { usuarioId } = await conferirContaCanario(cliente, email, papel);
      if (usuarioId !== null) {
        const { total, porTabela } = await contarLinhasPrivadas(cliente, usuarioId);
        if (total > 0) {
          throw new RecusaCanario(
            `PreCondicao: a conta canário ${papel} já tem ${total} linha(s) privada(s) (${Object.entries(
              porTabela,
            )
              .map(([t, n]) => `${t} ${n}`)
              .join(", ")}); esta execução não as cria nem as apaga. Nada foi escrito.`,
          );
        }
      }
      return usuarioId;
    };
    for (const papel of ordenados) await exigirVazia(papel, emails.get(papel) as string);
    // 4. Habilita (pelo único caminho de escrita). A conta entra no registro ANTES: se algo falhar daqui
    //    em diante, o fim desabilita. Conta que passou a existir agora (ou que ganhou linha no intervalo)
    //    é lida e CONTADA de novo, ainda com a trava, antes de ser tratada como desta execução.
    for (const papel of ordenados) {
      const email = emails.get(papel) as string;
      const conta: Conta = { papel, email, usuarioId: null };
      this.#habilitados.set(papel, conta);
      const { estado } = await this.#escrever(conta, (c) => habilitarNoCliente(c, email, papel));
      if (!estado.entradaPermitida) throw new Error(`o canário ${papel} não ficou habilitado`);
      const usuarioId = await exigirVazia(papel, email);
      if (!usuarioId) throw new Error(`o canário ${papel} não tem conta depois de habilitar`);
      conta.usuarioId = usuarioId;
    }
    this.#preparado = true;
  }

  // Sessão de 30 minutos para o canário, só se a preparação a autorizou. Devolve o token (para o cookie).
  async criarSessao(papel: Papel): Promise<{ id: string; usuarioId: string; token: string }> {
    this.#exigirViva();
    const conta = this.#habilitados.get(papel);
    if (!this.#preparado || !conta?.usuarioId) {
      throw new RecusaCanario("RecusaDeSessao: a preparação não foi autorizada e concluída");
    }
    const usuarioId = conta.usuarioId;
    return this.#escrever(conta, async (dono) => {
      const token = randomBytes(32).toString("base64url");
      const r = await dono.query<{ id: string }>(
        "insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '30 minutes') returning id::text as id",
        [usuarioId, token],
      );
      const id = r.rows[0]?.id as string;
      this.#sessoes.push({ id, usuarioId });
      return { id, usuarioId, token };
    });
  }

  // Apaga uma sessão que ESTA execução abriu, pelo id registrado.
  async encerrarSessao(id: string): Promise<void> {
    this.#exigirViva();
    await this.#apagarSessao(id);
  }

  async #apagarSessao(id: string): Promise<void> {
    const alvo = this.#sessoes.find((s) => s.id === id);
    if (!alvo) throw new RecusaCanario("RecusaDeSessao: sessão que esta execução não abriu");
    const conta = [...this.#habilitados.values()].find((c) => c.usuarioId === alvo.usuarioId);
    if (!conta) throw new RecusaCanario("RecusaDeSessao: conta fora do registro");
    await this.#escrever(conta, async (dono) => {
      await dono.query("delete from auth.session where id = $1 and user_id = $2", [
        id,
        alvo.usuarioId,
      ]);
    });
    this.#sessoes = this.#sessoes.filter((s) => s.id !== id);
  }

  // O `afterAll`: sessões registradas, todas as linhas privadas da conta e o desabilitar medido. Cada
  // etapa passa por `#escrever` (trava, proteção e id) e roda mesmo se a anterior falhar (desabilitar é o
  // sentido seguro); a trava é solta por último.
  async finalizar(): Promise<void> {
    this.#exigirViva();
    // Encerra primeiro: nada mais autoriza escrita nesta instância, falhe o que falhar daqui em diante.
    this.#encerrada = true;
    const erros: string[] = [];
    const tentar = async (rotulo: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (erro) {
        erros.push(`${rotulo}: ${erro instanceof Error ? erro.message : String(erro)}`);
      }
    };
    for (const s of [...this.#sessoes]) await tentar("sessão", () => this.#apagarSessao(s.id));
    for (const conta of this.#habilitados.values()) {
      // A limpeza só roda com a preparação autorizada E concluída.
      if (this.#preparado && conta.usuarioId) {
        const { usuarioId } = conta;
        await tentar(`limpeza ${conta.papel}`, () =>
          this.#escrever(conta, async (dono) => {
            await limparTudo(dono, usuarioId);
            const resto = await contarLinhasPrivadas(dono, usuarioId);
            if (resto.total !== 0) throw new Error("sobrou linha privada depois da limpeza");
          }),
        );
      }
      await tentar(`desabilitar ${conta.papel}`, () =>
        this.#escrever(conta, async (c) => {
          const r = await desabilitarNoCliente(c, conta.email, conta.papel);
          if (!r.confirmado) throw new Error("não confirmado desabilitado");
        }),
      );
    }
    if (this.#trava) {
      const trava = this.#trava;
      for (const email of this.#travados) {
        await tentar("soltar trava", () => soltarTrava(trava.cliente, email));
      }
      await tentar("fechar trava", () => trava.fechar());
      this.#trava = null;
      this.#travados = [];
    }
    if (erros.length > 0) throw new Error(`fim da execução com falhas: ${erros.join(" | ")}`);
  }
}
