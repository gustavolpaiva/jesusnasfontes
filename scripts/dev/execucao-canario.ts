import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { desabilitar, habilitar, lerEstado, type Papel } from "./canario";
import { type Fotografia, fotografar, limpar } from "./limpeza-canario";
import { conferirContaCanario, emailDoCanario, RecusaCanario } from "./protecao-canario";

// Uma EXECUÇÃO de teste com contas canário (plano 01-19). Dona de tudo o que a execução cria e de tudo
// o que ela desfaz, em três regras:
//
//   (a) a execução tem uma MARCA própria e registra o que cria: a fotografia das linhas que a conta já
//       tinha e o id de cada sessão que abriu. A limpeza apaga só o que é novo e leva a marca, relido
//       antes, com teto (ver `limpeza-canario.ts`); sessão só pelo id registrado.
//   (b) a proteção contra conta real vale no INÍCIO e no FIM: toda escrita é precedida de
//       `conferirContaCanario` (banco de dev, endereço marcado como canário, não é o Admin inicial,
//       papel certo), e a limpeza das linhas privadas só roda se a preparação foi autorizada E concluída.
//   (c) toda conexão que escreve confere o marcador `dev` do banco antes (a conferência está dentro de
//       `conferirContaCanario`, `fotografar` e `limpar`, que recebem a própria conexão).

type Dono = Pick<pg.Client, "query">;
type Pool = Pick<pg.Pool, "query" | "connect">;

export type Fabrica = {
  /** Conexão do dono do banco (ignora a RLS): só para fotografar, limpar e abrir sessão. */
  dono: () => Promise<{ cliente: Dono; fechar: () => Promise<void> }>;
  /** Conexão agrupada do aplicativo, a que `habilitar` e `desabilitar` usam. */
  pool: () => Pool;
};

type Conta = { papel: Papel; email: string; usuarioId: string | null; foto: Fotografia | null };

export class ExecucaoCanario {
  readonly marca = randomUUID();
  private habilitados = new Map<Papel, Conta>();
  private sessoes: { id: string; usuarioId: string }[] = [];
  private preparado = false;

  constructor(private readonly fabrica: Fabrica) {}

  get registro() {
    return {
      marca: this.marca,
      preparado: this.preparado,
      habilitados: [...this.habilitados.keys()],
      fotografados: [...this.habilitados.values()]
        .filter((c) => c.foto !== null)
        .map((c) => c.papel),
      sessoes: this.sessoes.map((s) => s.id),
    };
  }

  private async comDono<T>(fn: (c: Dono) => Promise<T>): Promise<T> {
    const { cliente, fechar } = await this.fabrica.dono();
    try {
      return await fn(cliente);
    } finally {
      await fechar();
    }
  }

  // Toda conferência ANTES de qualquer escrita; depois habilita e fotografa cada conta.
  async preparar(papeis: Papel[]): Promise<void> {
    const emails = new Map<Papel, string>();
    for (const papel of papeis) {
      const email = emailDoCanario(papel);
      if (!email) throw new RecusaCanario(`INDETERMINADO: o canário ${papel} não está no ambiente`);
      emails.set(papel, email);
    }
    await this.comDono(async (dono) => {
      for (const papel of papeis)
        await conferirContaCanario(dono, emails.get(papel) as string, papel);
    });
    for (const papel of papeis) {
      const email = emails.get(papel) as string;
      const conta: Conta = { papel, email, usuarioId: null, foto: null };
      // Registrada ANTES de habilitar: se algo falhar daqui em diante, o fim desabilita.
      this.habilitados.set(papel, conta);
      const { estado } = await habilitar(this.fabrica.pool(), email, papel, false);
      if (!estado.entradaPermitida) throw new Error(`o canário ${papel} não ficou habilitado`);
      await this.comDono(async (dono) => {
        const { usuarioId } = await conferirContaCanario(dono, email, papel);
        if (!usuarioId) throw new Error(`o canário ${papel} não tem conta depois de habilitar`);
        conta.usuarioId = usuarioId;
        conta.foto = await fotografar(dono, usuarioId);
      });
    }
    this.preparado = true;
  }

  // Sessão de 30 minutos para o canário, só se a preparação o autorizou. Devolve o token (para assinar o cookie).
  async criarSessao(papel: Papel): Promise<{ id: string; usuarioId: string; token: string }> {
    const conta = this.habilitados.get(papel);
    if (!this.preparado || !conta?.usuarioId || !conta.foto) {
      throw new RecusaCanario("RecusaDeSessao: a preparação não foi autorizada e concluída");
    }
    const usuarioId = conta.usuarioId;
    return this.comDono(async (dono) => {
      await conferirContaCanario(dono, conta.email, papel);
      const token = randomBytes(32).toString("base64url");
      const r = await dono.query<{ id: string }>(
        "insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '30 minutes') returning id::text as id",
        [usuarioId, token],
      );
      const id = r.rows[0]?.id as string;
      this.sessoes.push({ id, usuarioId });
      return { id, usuarioId, token };
    });
  }

  // Apaga uma sessão que ESTA execução abriu, pelo id registrado.
  async encerrarSessao(id: string): Promise<void> {
    const alvo = this.sessoes.find((s) => s.id === id);
    if (!alvo) throw new RecusaCanario("RecusaDeSessao: sessão que esta execução não abriu");
    const conta = [...this.habilitados.values()].find((c) => c.usuarioId === alvo.usuarioId);
    if (!conta) throw new RecusaCanario("RecusaDeSessao: conta fora do registro");
    await this.comDono(async (dono) => {
      await conferirContaCanario(dono, conta.email, conta.papel);
      await dono.query("delete from auth.session where id = $1 and user_id = $2", [
        id,
        alvo.usuarioId,
      ]);
    });
    this.sessoes = this.sessoes.filter((s) => s.id !== id);
  }

  // O `afterAll`: sessões registradas, linhas novas da conta e, por fim, o desabilitar medido. Cada etapa
  // roda mesmo se a anterior falhar (desabilitar é o sentido seguro); os erros saem juntos no fim.
  async finalizar(): Promise<void> {
    const erros: string[] = [];
    const tentar = async (rotulo: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (erro) {
        erros.push(`${rotulo}: ${erro instanceof Error ? erro.message : String(erro)}`);
      }
    };
    for (const s of [...this.sessoes]) await tentar("sessão", () => this.encerrarSessao(s.id));
    for (const conta of this.habilitados.values()) {
      // A limpeza das linhas só roda com a preparação autorizada E concluída, e depois de conferir de
      // novo que a conta é um canário marcado.
      if (this.preparado && conta.usuarioId && conta.foto) {
        const { usuarioId, foto } = conta;
        await tentar(`limpeza ${conta.papel}`, () =>
          this.comDono(async (dono) => {
            await conferirContaCanario(dono, conta.email, conta.papel);
            await limpar(dono, usuarioId, foto, this.marca);
          }),
        );
      }
      await tentar(`desabilitar ${conta.papel}`, async () => {
        const pool = this.fabrica.pool();
        const r = await desabilitar(pool, conta.email, conta.papel);
        const e = await lerEstado(pool, conta.email);
        if (!r.confirmado || e.sessoes !== 0 || e.entradaPermitida) {
          throw new Error("não confirmado desabilitado");
        }
      });
    }
    if (erros.length > 0) throw new Error(`fim da execução com falhas: ${erros.join(" | ")}`);
  }
}
