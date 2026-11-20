import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { ErroDeBanco } from "@/db/erro-banco";
import { usuario } from "@/db/schema/fundacao";
import { removerConta } from "@/modules/privacidade/remover-conta";
import { registrarConclusao } from "@/modules/trilhas/consultas";
import { removerBancoDeExecucao } from "../../support/banco-local";
import {
  type Conta,
  colunasLigadasAConta,
  comoDono,
  contagemDaConta,
  criarTerreno,
  semearConta,
  type Terreno,
  tabelasDoCatalogo,
} from "../../support/conta-completa";

// Apagar a conta (PRIV-03, ANOT-05): só a conta indicada por ID, nenhuma linha dela em nenhuma tabela
// que o CATÁLOGO liga à conta, as da conta vizinha intactas. Cria e APAGA contas num banco descartável
// só deste arquivo (nunca contra o Neon).

const emNeon = () => inject("alvoBanco") === "neon";

let t: Terreno;

beforeAll(async () => {
  if (emNeon()) return;
  t = await criarTerreno();
  Object.assign(process.env, t.env);
});

afterAll(async () => {
  if (emNeon()) return;
  await obterPool().end();
  await removerBancoDeExecucao(t.banco.nome);
});

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

const existe = (id: string) =>
  comoDono(t.env, async (c) => {
    const r = await c.query('select count(*)::int as n from auth."user" where id = $1', [id]);
    return r.rows[0]?.n === 1;
  });

// Espera até alguma consulta do banco deste teste estar bloqueada esperando uma trava.
async function esperarBloqueio(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const espera = await comoDono(t.env, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      );
      return r.rows[0]?.n as number;
    });
    if (espera > 0) return;
    await dormir(50);
  }
  throw new Error("Nenhuma consulta ficou esperando trava: o teste não provou a espera.");
}

describe.skipIf(emNeon())("removerConta", () => {
  it("antes: A e B têm linha em TODA tabela que o catálogo liga à conta (controle positivo da cobertura)", async () => {
    const ligadas = await colunasLigadasAConta(t.env);
    // Tabela nova ligada à conta sem linha de teste em conta-completa.ts faz isto falhar.
    for (const conta of [t.a, t.b]) {
      const contagem = await contagemDaConta(t.env, conta);
      for (const l of ligadas) {
        const nome = `${l.tabela}.${l.coluna}`;
        if (nome === "admin.convite.criado_por") continue; // vale para quem CRIOU o convite (abaixo)
        expect(
          contagem[nome],
          `${nome}: falta linha de teste de ${conta.marcador}`,
        ).toBeGreaterThan(0);
      }
      expect(contagem["sem-vinculo: convite e verificações"]).toBeGreaterThanOrEqual(4);
      expect(contagem["sem-vinculo: admin.tentativa"]).toBeGreaterThanOrEqual(5);
    }
    // Toda tabela de privado entra nas colunas ligadas (a FK estudante_id → auth.user).
    const privadas = await tabelasDoCatalogo(t.env, "privado");
    const comFk = new Set(ligadas.map((l) => l.tabela.replace("privado.", "")));
    for (const p of privadas) expect(comFk.has(p), `privado.${p}: FK para a conta`).toBe(true);
  });

  it("apagar A leva TODAS as linhas dela do catálogo e deixa a conta vizinha B intacta", async () => {
    const antesB = await contagemDaConta(t.env, t.b);
    const antesA = await contagemDaConta(t.env, t.a);
    expect(Object.values(antesA).every((n) => n >= 0)).toBe(true);

    expect(await removerConta(t.a.id)).toEqual({ ok: true });

    const depoisA = await contagemDaConta(t.env, t.a);
    for (const [onde, n] of Object.entries(depoisA)) expect(n, `A em ${onde}`).toBe(0);
    expect(await existe(t.a.id)).toBe(false);
    // Sessões, convite e verificações de A: zero (conferido direto, além do catálogo).
    expect(
      await comoDono(t.env, async (c) => {
        const r = await c.query(
          `select (select count(*) from auth.session where user_id = $1)::int as sessoes,
                  (select count(*) from admin.convite where email_norm = $2)::int as convites,
                  (select count(*) from auth.verification where identifier like '%' || $2 || '%')::int as codigos`,
          [t.a.id, t.a.email],
        );
        return r.rows[0];
      }),
    ).toEqual({ sessoes: 0, convites: 0, codigos: 0 });

    // Controle negativo: B ficou exatamente como estava, linha por linha contada.
    expect(await contagemDaConta(t.env, t.b)).toEqual(antesB);
    expect(await existe(t.b.id)).toBe(true);
    // O convite que A criou para uma terceira pessoa continua, só sem o autor (set null).
    const convidado = await comoDono(t.env, async (c) => {
      const r = await c.query("select criado_por from admin.convite where email_norm = $1", [
        t.convidadoPorA,
      ]);
      return r.rows;
    });
    expect(convidado).toEqual([{ criado_por: null }]);
  });

  it("apagar de novo, ou um ID que não existe, não apaga mais nada", async () => {
    const antesB = await contagemDaConta(t.env, t.b);
    expect(await removerConta(t.a.id)).toEqual({ ok: false, erro: "inexistente" });
    expect(await removerConta(randomUUID())).toEqual({ ok: false, erro: "inexistente" });
    expect(await contagemDaConta(t.env, t.b)).toEqual(antesB);
    const usuarios = await obterDb().select({ id: usuario.id }).from(usuario);
    expect(usuarios.map((u) => u.id)).toContain(t.b.id);
  });
});

describe.skipIf(emNeon())("o único Admin não se apaga", () => {
  const criar = async (prefixo: string, admin: boolean): Promise<Conta> => {
    const id = randomUUID();
    const conta = {
      id,
      email: `${prefixo}-${id.slice(0, 8)}@convite.example`,
      marcador: `MARCADOR-${prefixo}-${id}`,
      sessaoId: randomUUID(),
    };
    await semearConta(t.env, conta, t, { admin });
    return conta;
  };

  it("com outro Admin de convite ativo apaga; sozinho, não; convite revogado não conta", async () => {
    // Os Admins de teste são os únicos deste banco: um só Admin sem sucessor é recusado.
    const x = await criar("admin-x", true);
    expect(await removerConta(x.id)).toEqual({ ok: false, erro: "unico-admin" });
    expect(await existe(x.id)).toBe(true);
    expect(await contagemDaConta(t.env, x)).toMatchObject({
      "sem-vinculo: convite e verificações": 4,
    });

    // Um segundo Admin com convite REVOGADO não é sucessor.
    const y = await criar("admin-y", true);
    await comoDono(t.env, (c) =>
      c.query("update admin.convite set estado = 'revogado' where email_norm = $1", [y.email]),
    );
    expect(await removerConta(x.id)).toEqual({ ok: false, erro: "unico-admin" });

    // Reativado, é sucessor: X apaga, e Y, agora único, não.
    await comoDono(t.env, (c) =>
      c.query("update admin.convite set estado = 'aceito' where email_norm = $1", [y.email]),
    );
    expect(await removerConta(x.id)).toEqual({ ok: true });
    expect(await removerConta(y.id)).toEqual({ ok: false, erro: "unico-admin" });
    expect(await existe(y.id)).toBe(true);
  });

  it("um Estudante comum apaga sem depender de nenhum Admin", async () => {
    const e = await criar("estudante-solto", false);
    expect(await removerConta(e.id)).toEqual({ ok: true });
  });
});

describe.skipIf(emNeon())("apagar ao mesmo tempo que outra aba grava", () => {
  async function contaNova(prefixo: string): Promise<Conta> {
    const id = randomUUID();
    const conta = {
      id,
      email: `${prefixo}-${id.slice(0, 8)}@convite.example`,
      marcador: `MARCADOR-${prefixo}-${id}`,
      sessaoId: randomUUID(),
    };
    await semearConta(t.env, conta, t);
    return conta;
  }

  const linhasDeConclusao = (id: string) =>
    comoDono(t.env, async (c) => {
      const r = await c.query(
        "select count(*)::int as n from privado.conclusao where estudante_id = $1",
        [id],
      );
      return r.rows[0]?.n as number;
    });

  // Duas travas, as duas ordens possíveis: a escrita que já passou pela trava de progresso e está no meio,
  // e a escrita que só segura a chave estrangeira (como a posição de leitura). Em ambas a remoção ESPERA
  // a escrita terminar e a cascata a leva: nada de linha órfã.
  it("escrita de progresso em curso: a remoção espera a trava, termina depois e não deixa linha de A", async () => {
    const a = await contaNova("corrida-progresso");
    const antes = await linhasDeConclusao(a.id);
    const { default: pg } = await import("pg");
    const cliente = new pg.Client({ connectionString: t.env.DATABASE_URL_OWNER });
    await cliente.connect();
    try {
      await cliente.query("begin");
      await cliente.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `jnf-progresso:${a.id}`,
      ]);
      await cliente.query(
        "insert into privado.conclusao (estudante_id, estudo_id, volta) values ($1, $2, 7)",
        [a.id, t.estudos[0]],
      );
      const remocao = removerConta(a.id);
      let terminou = false;
      void remocao.then(() => {
        terminou = true;
      });
      await esperarBloqueio();
      // Controle positivo de que a espera é real: com a escrita aberta, a remoção NÃO terminou.
      await dormir(150);
      expect(terminou).toBe(false);
      expect(await existe(a.id)).toBe(true);
      await cliente.query("commit");
      expect(await remocao).toEqual({ ok: true });
    } finally {
      await cliente.end();
    }
    expect(antes).toBeGreaterThan(0);
    expect(await linhasDeConclusao(a.id)).toBe(0);
    expect(await existe(a.id)).toBe(false);
  });

  it("escrita que só segura a chave estrangeira (sem a trava de progresso): a remoção espera e leva a linha", async () => {
    const a = await contaNova("corrida-fk");
    const { default: pg } = await import("pg");
    const cliente = new pg.Client({ connectionString: t.env.DATABASE_URL_OWNER });
    await cliente.connect();
    try {
      await cliente.query("begin");
      await cliente.query(
        "insert into privado.conclusao (estudante_id, estudo_id, volta) values ($1, $2, 8)",
        [a.id, t.estudos[1]],
      );
      const remocao = removerConta(a.id);
      let terminou = false;
      void remocao.then(() => {
        terminou = true;
      });
      await esperarBloqueio();
      await dormir(150);
      expect(terminou).toBe(false);
      await cliente.query("commit");
      expect(await remocao).toEqual({ ok: true });
    } finally {
      await cliente.end();
    }
    expect(await linhasDeConclusao(a.id)).toBe(0);
  });

  it("escrita DEPOIS de apagar: a chave estrangeira recusa (23503, constraint de estudante_id), sem linha órfã e sem erro cru", async () => {
    const a = await contaNova("corrida-depois");
    expect(await removerConta(a.id)).toEqual({ ok: true });
    const erro = await registrarConclusao(a.id, t.estudos[0]).catch((e: unknown) => e);
    // É o erro SANEADO da camada de banco (sem consulta nem parâmetros), que as ações de progresso
    // traduzem em "sessão encerrada".
    expect(erro).toBeInstanceOf(ErroDeBanco);
    expect((erro as ErroDeBanco).code).toBe("23503");
    expect((erro as ErroDeBanco).constraint).toContain("estudante_id");
    expect(JSON.stringify(erro)).not.toContain(a.id);
    expect(await linhasDeConclusao(a.id)).toBe(0);
  });
});
