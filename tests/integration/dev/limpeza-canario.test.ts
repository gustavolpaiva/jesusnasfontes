import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { desabilitar, habilitar } from "../../../scripts/dev/canario";
import { desabilitarNoCliente, habilitarNoCliente } from "../../../scripts/dev/escritas-canario";
import {
  ExecucaoCanario,
  ExecucaoEncerrada,
  type Fabrica,
  METODOS_QUE_ESCREVEM,
} from "../../../scripts/dev/execucao-canario";
import {
  AlvoAMais,
  contarLinhasPrivadas,
  limparTudo,
  TETO_POR_TABELA,
} from "../../../scripts/dev/limpeza-canario";
import { OutraExecucao, tomarTrava } from "../../../scripts/dev/trava-canario";
import { conferirContaCanario, RecusaCanario } from "../../../scripts/dev/protecao-canario";
import { ESTUDO_DE_TESTE } from "../../support/estudo-de-teste";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// Cada recusa da proteção e da limpeza do canário, provada no banco LOCAL descartável (nunca no Neon: o
// arquivo cria contas e linhas e é ignorado lá). Prova negativa em todos os casos: depois da recusa, o
// que existia continua existindo e nada foi escrito.

const emNeon = () => inject("alvoBanco") === "neon";
const rodada = randomUUID().slice(0, 8);
const usuarios: string[] = [];
let dono: pg.Client;

const novoEmail = (nome: string) => `${nome}-${rodada}-${randomUUID().slice(0, 4)}@example.test`;

async function criarConta(email: string, role: "estudante" | "admin" = "estudante") {
  const r = await dono.query<{ id: string }>(
    'insert into auth."user" (email, role) values ($1, $2) returning id::text as id',
    [email, role],
  );
  const id = r.rows[0]?.id as string;
  usuarios.push(email);
  return id;
}

const contar = async (sql: string, p: unknown[] = []) =>
  Number((await dono.query<{ n: string }>(sql, p)).rows[0]?.n);
const consentimentos = (id: string) =>
  contar("select count(*) as n from privado.consentimento where estudante_id = $1", [id]);

async function darAceite(id: string, versao: string, texto = "t") {
  await dono.query(
    "insert into privado.consentimento (estudante_id, versao_aviso, texto_hash) values ($1, $2, $3)",
    [id, versao, texto],
  );
}

beforeAll(async () => {
  if (emNeon()) return;
  aplicarEnvDeTeste();
  dono = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await dono.connect();
});

beforeEach(() => {
  delete process.env.JNF_CANARIO_ESTUDANTE_EMAIL;
  delete process.env.JNF_CANARIO_ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL_INICIAL;
});

afterAll(async () => {
  if (emNeon()) return;
  if (usuarios.length > 0) {
    await dono.query('delete from auth."user" where email = any($1)', [usuarios]);
    await dono.query("delete from admin.convite where email_norm = any($1)", [usuarios]);
  }
  await dono.end();
  await obterPool().end();
});

const conexaoDireta = async () => {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  return { cliente, fechar: () => cliente.end() };
};
const fabricaLocal = (): Fabrica => ({
  dono: conexaoDireta,
  trava: conexaoDireta,
});

describe.skipIf(emNeon())("proteção da conta canário", () => {
  it("recusa a conta do Admin inicial, por habilitar e por desabilitar, sem escrever", async () => {
    const real = novoEmail("real");
    const idReal = await criarConta(real, "admin");
    await dono.query(
      "insert into admin.convite (email_norm, estado) values ($1, 'aceito') on conflict do nothing",
      [real],
    );
    process.env.ADMIN_EMAIL_INICIAL = real;
    process.env.JNF_CANARIO_ADMIN_EMAIL = real; // o canário apontado, por engano, para a conta real
    const pool = obterPool();
    await expect(habilitar(pool, real, "admin", false)).rejects.toBeInstanceOf(RecusaCanario);
    await expect(desabilitar(pool, real, "admin")).rejects.toBeInstanceOf(RecusaCanario);
    await expect(conferirContaCanario(pool, real, "admin")).rejects.toBeInstanceOf(RecusaCanario);
    // Nada mudou: convite ainda aceito, conta ainda existe, nenhuma linha de segundo fator mexida.
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'aceito'",
        [real],
      ),
    ).toBe(1);
    expect(await contar('select count(*) as n from auth."user" where id = $1', [idReal])).toBe(1);
  });

  it("recusa endereço que não é o de um canário marcado, mesmo existindo e sendo estudante", async () => {
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("outro-admin");
    const pessoa = novoEmail("pessoa");
    await criarConta(pessoa);
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = novoEmail("marcado");
    await expect(habilitar(obterPool(), pessoa, "estudante", false)).rejects.toBeInstanceOf(
      RecusaCanario,
    );
    await expect(desabilitar(obterPool(), pessoa)).rejects.toBeInstanceOf(RecusaCanario);
    expect(
      await contar("select count(*) as n from admin.convite where email_norm = $1", [pessoa]),
    ).toBe(0);
  });

  it("recusa conta cujo papel não é o do canário", async () => {
    const e = novoEmail("papel");
    await criarConta(e, "admin");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real2");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e; // marcado como estudante, mas a conta é Admin
    await expect(conferirContaCanario(obterPool(), e, "estudante")).rejects.toThrow(
      /papel da conta/,
    );
  });

  it("desabilitar sem papel confere a função pela variável: a variável do Estudante apontando para um Admin não revoga nada", async () => {
    const e = novoEmail("estudante-que-e-admin");
    const id = await criarConta(e, "admin");
    await dono.query(
      "insert into admin.convite (email_norm, estado) values ($1, 'aceito') on conflict do nothing",
      [e],
    );
    await dono.query(
      "insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '1 hour')",
      [id, randomUUID()],
    );
    await dono.query(
      "insert into auth.two_factor (user_id, secret, backup_codes) values ($1, 'x', 'y')",
      [id],
    );
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-papel");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e; // marcada como Estudante, mas a conta é Admin
    await expect(desabilitar(obterPool(), e)).rejects.toThrow(/papel da conta/);
    await expect(desabilitar(obterPool(), e, "estudante")).rejects.toThrow(/papel da conta/);
    // Papel pedido diferente do da variável também recusa, em habilitar e em desabilitar.
    await expect(habilitar(obterPool(), e, "admin", false)).rejects.toThrow(/papel pedido/);
    await expect(desabilitar(obterPool(), e, "admin")).rejects.toThrow(/papel pedido/);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'aceito'",
        [e],
      ),
    ).toBe(1);
    expect(await contar("select count(*) as n from auth.session where user_id = $1", [id])).toBe(1);
    expect(await contar("select count(*) as n from auth.two_factor where user_id = $1", [id])).toBe(
      1,
    );
  });

  it("sem ADMIN_EMAIL_INICIAL no ambiente a proteção recusa (sem prova, não segue)", async () => {
    const e = novoEmail("semreal");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    await expect(habilitar(obterPool(), e, "estudante", false)).rejects.toThrow(/INDETERMINADO/);
    expect(await contar("select count(*) as n from admin.convite where email_norm = $1", [e])).toBe(
      0,
    );
  });

  it("banco que não é o de dev: toda função recusa ANTES de qualquer escrita", async () => {
    const consultas: string[] = [];
    const prod = {
      query: async (sql: string) => {
        consultas.push(sql);
        return { rows: [{ nome: "producao" }], rowCount: 1 };
      },
      connect: async () => {
        throw new Error("não devia abrir transação");
      },
    };
    const e = novoEmail("prod");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real3");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const id = randomUUID();
    await expect(habilitar(prod as never, e, "estudante", false)).rejects.toThrow(
      /RecusaDeAmbiente/,
    );
    await expect(desabilitar(prod as never, e, "estudante")).rejects.toThrow(/RecusaDeAmbiente/);
    await expect(tomarTrava(prod as never, e)).rejects.toThrow(/RecusaDeAmbiente/);
    await expect(limparTudo(prod as never, id)).rejects.toThrow(/RecusaDeAmbiente/);
    // Só a leitura do marcador, nenhuma escrita nem transação.
    expect(consultas.every((s) => /^select nome from acervo\.ambiente/.test(s))).toBe(true);
    expect(consultas.length).toBe(4);
  });
});

describe.skipIf(emNeon())("limpeza de todas as linhas privadas da conta canário", () => {
  it("apaga tudo o que a conta tem, confere zero e não toca outra conta", async () => {
    const a = await criarConta(novoEmail("a"));
    const b = await criarConta(novoEmail("b"));
    await darAceite(a, "v1");
    await darAceite(a, "v2");
    await dono.query(
      "insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, $2, 'sem marca nenhuma')",
      [a, ESTUDO_DE_TESTE.id],
    );
    await darAceite(b, "da-b");
    const apagadas = await limparTudo(dono, a);
    expect(apagadas).toEqual({ anotacao: 1, consentimento: 2 });
    expect((await contarLinhasPrivadas(dono, a)).total).toBe(0);
    expect(await consentimentos(b)).toBe(1);
  });

  it("mais linhas que o teto: aborta sem escrever", async () => {
    const id = await criarConta(novoEmail("teto"));
    // O teto é pequeno de propósito (o teste não pode passar com um teto frouxo).
    expect(TETO_POR_TABELA).toBeLessThanOrEqual(10);
    for (let i = 0; i < 11; i++) await darAceite(id, `v${i}`);
    await expect(limparTudo(dono, id)).rejects.toBeInstanceOf(AlvoAMais);
    expect(await consentimentos(id)).toBe(11);
  });
});

describe.skipIf(emNeon())("escritas na conexão da trava", () => {
  it("habilitar e desabilitar no cliente: estudante e Admin chegam ao estado final medido", async () => {
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-esc");
    const est = novoEmail("esc-est");
    const adm = novoEmail("esc-adm");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = est;
    process.env.JNF_CANARIO_ADMIN_EMAIL = adm;
    usuarios.push(est, adm);
    // Estudante: conta nova, convite pendente, papel certo; de novo é idempotente.
    const r1 = await habilitarNoCliente(dono, est, "estudante");
    expect(r1.criado).toBe(true);
    expect(r1.estado).toMatchObject({ convite: "pendente", entradaPermitida: true });
    expect((await habilitarNoCliente(dono, est, "estudante")).criado).toBe(false);
    const d1 = await desabilitarNoCliente(dono, est, "estudante");
    expect(d1.confirmado).toBe(true);
    expect(d1.estado.convite).toBe("revogado");
    expect((await habilitarNoCliente(dono, est, "estudante")).criado).toBe(true); // reativa o revogado
    // Admin com tudo o que o segundo fator deixa: fator, sessão, verificação pendente.
    const id = await criarConta(adm, "admin");
    const sujar = async () => {
      await dono.query(
        "insert into auth.two_factor (user_id, secret, backup_codes) values ($1, 'x', 'y')",
        [id],
      );
      await dono.query('update auth."user" set two_factor_enabled = true where id = $1', [id]);
      await dono.query(
        "insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '1 hour')",
        [id, randomUUID()],
      );
      await dono.query(
        "insert into auth.verification (identifier, value, expires_at) values ($1, 'h', now() + interval '1 hour')",
        [`sign-in-otp-${adm}`],
      );
    };
    await sujar();
    const h = await habilitarNoCliente(dono, adm, "admin");
    expect(h.estado).toMatchObject({ convite: "pendente", sessoes: 0 });
    expect(await contar("select count(*) as n from auth.two_factor where user_id = $1", [id])).toBe(
      0,
    );
    await sujar();
    const d = await desabilitarNoCliente(dono, adm, "admin");
    expect(d).toMatchObject({ confirmado: true, sessoesAnteriores: 1, segundosFatores: 0 });
    expect(d.estado.convite).toBe("revogado");
    expect(
      await contar("select count(*) as n from auth.verification where identifier = $1", [
        `sign-in-otp-${adm}`,
      ]),
    ).toBe(0);
    expect(
      await contar('select count(*) as n from auth."user" where id = $1 and two_factor_enabled', [
        id,
      ]),
    ).toBe(0);
  });

  it("a conexão da trava cai ENTRE a conferência e a escrita: nada é escrito (sessão)", async () => {
    const e = novoEmail("queda-escrita");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-qe");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    let armada = false;
    let pid = 0;
    const x = new ExecucaoCanario({
      ...base,
      trava: async () => {
        const t = await base.trava();
        pid = (t.cliente as unknown as { processID: number }).processID;
        (t.cliente as pg.Client).on("error", () => undefined);
        const query = t.cliente.query.bind(t.cliente) as (...a: unknown[]) => Promise<unknown>;
        return {
          ...t,
          cliente: {
            query: async (sql: string, p?: unknown[]) => {
              // Já passou a conferência da escrita; um instante antes do INSERT a conexão cai.
              if (armada && /^insert into auth\.session/.test(sql)) {
                await dono.query("select pg_terminate_backend($1)", [pid]);
                await new Promise((r) => setTimeout(r, 100));
              }
              return query(sql, p);
            },
          } as never,
        };
      },
    });
    await x.preparar(["estudante"]);
    usuarios.push(e);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    armada = true;
    await expect(x.criarSessao("estudante")).rejects.toThrow();
    armada = false;
    expect(await contar("select count(*) as n from auth.session where user_id = $1", [id])).toBe(0);
    expect(x.registro.sessoes).toEqual([]);
    await x.finalizar().catch(() => undefined);
  });

  it("a conexão da trava cai ENTRE a conferência e o DELETE da limpeza: nada é apagado", async () => {
    const e = novoEmail("queda-limpeza");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-ql");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    let armada = false;
    let pid = 0;
    const x = new ExecucaoCanario({
      ...base,
      trava: async () => {
        const t = await base.trava();
        pid = (t.cliente as unknown as { processID: number }).processID;
        (t.cliente as pg.Client).on("error", () => undefined);
        const query = t.cliente.query.bind(t.cliente) as (...a: unknown[]) => Promise<unknown>;
        return {
          ...t,
          cliente: {
            query: async (sql: string, p?: unknown[]) => {
              if (armada && /^delete from privado\./.test(sql)) {
                await dono.query("select pg_terminate_backend($1)", [pid]);
                await new Promise((r) => setTimeout(r, 100));
              }
              return query(sql, p);
            },
          } as never,
        };
      },
    });
    await x.preparar(["estudante"]);
    usuarios.push(e);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    await darAceite(id, "nao-pode-sumir");
    armada = true;
    await expect(x.finalizar()).rejects.toThrow(/limpeza/);
    armada = false;
    expect(await consentimentos(id)).toBe(1); // a transação morreu com a conexão: nada foi apagado
  });
});

describe.skipIf(emNeon())("o teto vale sobre o que o DELETE apagou", () => {
  it("linha inserida entre a leitura e o DELETE passa do teto: reverte tudo", async () => {
    const id = await criarConta(novoEmail("corrida"));
    await darAceite(id, "uma");
    const outra = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await outra.connect();
    // Um cliente que, na hora exata do DELETE, deixa outro escritor inserir 11 linhas (o que uma
    // contagem prévia de 1 linha não enxergaria).
    const comCorrida = {
      query: async (sql: string, parametros?: unknown[]) => {
        if (/^delete from privado\.consentimento/.test(sql)) {
          for (let i = 0; i < 11; i++) {
            await outra.query(
              "insert into privado.consentimento (estudante_id, versao_aviso, texto_hash) values ($1, $2, 't')",
              [id, `corrida-${i}`],
            );
          }
        }
        return dono.query(sql, parametros);
      },
    };
    try {
      await expect(limparTudo(comCorrida as never, id)).rejects.toBeInstanceOf(AlvoAMais);
    } finally {
      await outra.end();
    }
    expect(await consentimentos(id)).toBe(12); // nada foi apagado: a transação reverteu
  });
});

describe.skipIf(emNeon())("execução de canário: trava, conta vazia e limpeza", () => {
  it("execução que nunca preparou não escreve nada ao finalizar", async () => {
    const abriu = vi.fn();
    const fabrica = fabricaLocal();
    const x = new ExecucaoCanario({
      ...fabrica,
      dono: async () => {
        abriu();
        return fabrica.dono();
      },
    });
    await x.finalizar();
    expect(abriu).not.toHaveBeenCalled();
  });

  it("preparação recusada (canário é o Admin inicial) não trava, não habilita nem apaga nada", async () => {
    const real = novoEmail("real4");
    const idReal = await criarConta(real, "admin");
    await darAceite(idReal, "do-admin-real");
    process.env.ADMIN_EMAIL_INICIAL = real;
    process.env.JNF_CANARIO_ADMIN_EMAIL = real;
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = novoEmail("est5");
    const x = new ExecucaoCanario(fabricaLocal());
    await expect(x.preparar(["estudante", "admin"])).rejects.toBeInstanceOf(RecusaCanario);
    expect(x.registro.habilitados).toEqual([]);
    expect(x.registro.travados).toBe(0);
    await x.finalizar();
    expect(await consentimentos(idReal)).toBe(1);
    expect(
      await contar("select count(*) as n from admin.convite where email_norm = $1", [real]),
    ).toBe(0);
    await expect(x.criarSessao("admin")).rejects.toBeInstanceOf(RecusaCanario);
  });

  it("canário com linha privada prévia: aborta antes de escrever, diz quantas, e a linha sobrevive", async () => {
    const e = novoEmail("previa");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real8");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const id = await criarConta(e);
    await darAceite(id, "do-dono-no-celular");
    await darAceite(id, "outra");
    const x = new ExecucaoCanario(fabricaLocal());
    await expect(x.preparar(["estudante"])).rejects.toThrow(
      /PreCondicao.*2 linha.*consentimento 2/,
    );
    expect(x.registro.habilitados).toEqual([]);
    expect(await contar("select count(*) as n from admin.convite where email_norm = $1", [e])).toBe(
      0,
    );
    await x.finalizar();
    expect(await consentimentos(id)).toBe(2);
    // A trava foi solta: uma execução nova a toma (e recusa de novo pela mesma razão, não pela trava).
    const y = new ExecucaoCanario(fabricaLocal());
    await expect(y.preparar(["estudante"])).rejects.toThrow(/PreCondicao/);
    await y.finalizar();
  });

  it("segunda execução simultânea na mesma conta: recusa sem escrever e não apaga nada da primeira", async () => {
    const e = novoEmail("dupla");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real9");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const x1 = new ExecucaoCanario(fabricaLocal());
    await x1.preparar(["estudante"]);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    usuarios.push(e);
    await darAceite(id, "da-primeira-execucao");
    const x2 = new ExecucaoCanario(fabricaLocal());
    await expect(x2.preparar(["estudante"])).rejects.toBeInstanceOf(OutraExecucao);
    expect(x2.registro.habilitados).toEqual([]);
    await x2.finalizar(); // a segunda não é dona de nada: não apaga, não desabilita, não solta a trava alheia
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado <> 'revogado'",
        [e],
      ),
    ).toBe(1);
    // A trava da primeira continua valendo depois do fim da segunda.
    await expect(
      tomarTrava((await conexaoDireta()).cliente, e).then(() => "tomou"),
    ).rejects.toBeInstanceOf(OutraExecucao);
    await x1.finalizar();
    expect(await consentimentos(id)).toBe(0);
    // Solta ao fim da primeira, uma terceira toma.
    const x3 = new ExecucaoCanario(fabricaLocal());
    await x3.preparar(["estudante"]);
    await x3.finalizar();
  });

  async function prepararComTravaDerrubavel(e: string) {
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-trava");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    const pids: number[] = [];
    const x = new ExecucaoCanario({
      ...base,
      trava: async () => {
        const c = await conexaoDireta();
        (c.cliente as pg.Client).on("error", () => undefined); // a derrubada é o próprio teste
        pids.push((c.cliente as unknown as { processID: number }).processID);
        return c;
      },
    });
    await x.preparar(["estudante"]);
    usuarios.push(e);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    const derrubar = () => dono.query("select pg_terminate_backend($1)", [pids[0]]);
    return { x, id, derrubar };
  }

  it("trava perdida e livre: o fim a retoma sem esperar, reconfere tudo e conclui", async () => {
    const e = novoEmail("retoma");
    const { x, id, derrubar } = await prepararComTravaDerrubavel(e);
    await darAceite(id, "desta-execucao");
    await derrubar();
    await x.finalizar();
    expect(await consentimentos(id)).toBe(0);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1);
    // A trava retomada foi solta ao fim: uma execução nova a toma.
    const y = new ExecucaoCanario(fabricaLocal());
    await y.preparar(["estudante"]);
    await y.finalizar();
  });

  it("trava perdida e outra execução com a conta: o fim não escreve NADA, nem desabilita, e diz quem detém", async () => {
    const e = novoEmail("outra-detem");
    const { x: a, id, derrubar } = await prepararComTravaDerrubavel(e);
    await derrubar(); // A perde a conexão da trava
    const b = new ExecucaoCanario(fabricaLocal());
    await b.preparar(["estudante"]); // B toma a trava e prepara a mesma conta
    const sessaoDeB = await b.criarSessao("estudante");
    await darAceite(id, "de-B");
    await expect(a.finalizar()).rejects.toThrow(/OutraExecucao.*detém a conta/);
    // Nada de B foi tocado: convite ativo, sessão, linha.
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado <> 'revogado'",
        [e],
      ),
    ).toBe(1);
    expect(
      await contar("select count(*) as n from auth.session where id = $1", [sessaoDeB.id]),
    ).toBe(1);
    expect(await consentimentos(id)).toBe(1);
    await b.finalizar(); // B segue dona e conclui normalmente
    expect(await consentimentos(id)).toBe(0);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1);
  });

  it("todo método público que escreve recusa sem a trava (a lista é enumerada, não assumida)", async () => {
    // A lista de métodos públicos da classe é a de `METODOS_QUE_ESCREVEM`: método novo reprova aqui.
    const publicos = Object.getOwnPropertyNames(ExecucaoCanario.prototype).filter(
      (n) =>
        n !== "constructor" &&
        typeof Object.getOwnPropertyDescriptor(ExecucaoCanario.prototype, n)?.value === "function",
    );
    expect([...publicos].sort()).toEqual([...METODOS_QUE_ESCREVEM].sort());

    const e = novoEmail("sem-trava");
    const { x: a, id, derrubar } = await prepararComTravaDerrubavel(e);
    const sessaoDeA = await a.criarSessao("estudante");
    await derrubar(); // A perde a conexão da trava
    const b = new ExecucaoCanario(fabricaLocal());
    await b.preparar(["estudante"]); // B detém a conta
    const sessaoDeB = await b.criarSessao("estudante");
    await darAceite(id, "de-B");
    const sessoes = () => contar("select count(*) as n from auth.session where user_id = $1", [id]);
    const convitesAtivos = () =>
      contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado <> 'revogado'",
        [e],
      );
    expect(await sessoes()).toBe(2);
    // Um chamador por método escritor; o tipo exige todos, a ordem põe `finalizar` por último.
    const chamadas: Record<(typeof METODOS_QUE_ESCREVEM)[number], () => Promise<unknown>> = {
      preparar: () => new ExecucaoCanario(fabricaLocal()).preparar(["estudante"]),
      criarSessao: () => a.criarSessao("estudante"),
      encerrarSessao: () => a.encerrarSessao(sessaoDeA.id),
      finalizar: () => a.finalizar(),
    };
    for (const metodo of METODOS_QUE_ESCREVEM) {
      await expect(chamadas[metodo](), metodo).rejects.toThrow(/OutraExecucao/);
      // Nada foi escrito: as duas sessões, o convite ativo e a linha de B continuam.
      expect(await sessoes(), metodo).toBe(2);
      expect(await convitesAtivos(), metodo).toBe(1);
      expect(await consentimentos(id), metodo).toBe(1);
    }
    expect(
      await contar("select count(*) as n from auth.session where id = $1", [sessaoDeB.id]),
    ).toBe(1);
    await b.finalizar();
  });

  it("queda ociosa da conexão da trava não vira exceção sem dono: marca a trava como perdida e o fim a retoma", async () => {
    const e = novoEmail("queda");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real-queda");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    let pid = 0;
    const x = new ExecucaoCanario({
      ...base,
      // Conexão da trava SEM nenhum ouvinte de `error` posto pelo teste: quem ouve é a execução.
      trava: async () => {
        const c = await conexaoDireta();
        pid = (c.cliente as unknown as { processID: number }).processID;
        return c;
      },
    });
    await x.preparar(["estudante"]);
    usuarios.push(e);
    expect(x.registro.travaPerdida).toBe(false);
    await dono.query("select pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(x.registro.travaPerdida).toBe(true), { timeout: 5000 });
    await x.finalizar(); // retoma (ninguém mais a detém) e conclui
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1);
  });

  it("preparação que não concluiu: o fim desabilita mas NÃO apaga linhas privadas", async () => {
    const e = novoEmail("meio");
    const eAdmin = novoEmail("meio-admin");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real5");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    process.env.JNF_CANARIO_ADMIN_EMAIL = eAdmin;
    usuarios.push(e, eAdmin);
    const base = fabricaLocal();
    // Tudo passa pela conexão da trava: a falha vem na 10ª leitura do marcador dev dela, a do estudante
    // depois de habilitar (2 travas, 2 pré-condições, e por conta: conferência da escrita, do habilitar e
    // da pré-condição de depois; as contas vão em ordem alfabética, o Admin antes).
    const x = new ExecucaoCanario({
      ...base,
      trava: async () => {
        const t = await base.trava();
        let ambientes = 0;
        const query = t.cliente.query.bind(t.cliente) as (...a: unknown[]) => Promise<unknown>;
        return {
          ...t,
          cliente: {
            query: async (sql: string, p?: unknown[]) => {
              if (/acervo\.ambiente/.test(sql) && ++ambientes === 10) {
                throw new Error("falha simulada na preparação");
              }
              return query(sql, p);
            },
          } as never,
        };
      },
    });
    await expect(x.preparar(["estudante", "admin"])).rejects.toThrow(/falha simulada/);
    expect(x.registro.preparado).toBe(false);
    const idConta = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        eAdmin,
      ])
    ).rows[0]?.id as string;
    await darAceite(idConta, "escrita-depois"); // conta que já tem id: a limpeza a alcançaria se não fosse o guarda
    await x.finalizar();
    expect(await consentimentos(idConta)).toBe(1);
    for (const email of [e, eAdmin]) {
      expect(
        await contar(
          "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
          [email],
        ),
      ).toBe(1);
    }
  });

  it("a proteção vale também no FIM: se o canário deixou de ser o marcado, nada é apagado nem desabilitado", async () => {
    const e = novoEmail("fim");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real7");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const x = new ExecucaoCanario(fabricaLocal());
    await x.preparar(["estudante"]);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    usuarios.push(e);
    await darAceite(id, "nova");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = novoEmail("trocado");
    await expect(x.finalizar()).rejects.toThrow(/RecusaDeConta/);
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado <> 'revogado'",
        [e],
      ),
    ).toBe(1);
    // A execução recusada soltou a trava e não tocou em nada: a linha segue lá (o dono limpa à mão).
    await expect(tomarTrava((await conexaoDireta()).cliente, e)).resolves.toBeUndefined();
    expect(await consentimentos(id)).toBe(1);
  });

  it("conta criada por outra execução entre a proteção e a trava: a pré-condição lê DEPOIS da trava e aborta", async () => {
    const e = novoEmail("corrida-id");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real13");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    let id = "";
    const x = new ExecucaoCanario({
      ...base,
      // No intervalo, outra execução cria a conta e deixa um dado: a proteção (já lida) via "conta inexistente".
      trava: async () => {
        id = await criarConta(e);
        await darAceite(id, "da-outra-execucao");
        return base.trava();
      },
    });
    await expect(x.preparar(["estudante"])).rejects.toThrow(/PreCondicao.*1 linha/);
    expect(x.registro.preparado).toBe(false);
    await x.finalizar();
    expect(await consentimentos(id)).toBe(1); // o dado da outra execução NÃO foi apagado
  });

  it("conta que ganha linha depois de habilitar é recontada com a trava: aborta e nada é apagado", async () => {
    const e = novoEmail("corrida-depois");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real14");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const base = fabricaLocal();
    const x = new ExecucaoCanario({
      ...base,
      trava: async () => {
        const t = await base.trava();
        let ambientes = 0;
        const query = t.cliente.query.bind(t.cliente) as (...a: unknown[]) => Promise<unknown>;
        return {
          ...t,
          cliente: {
            query: async (sql: string, p?: unknown[]) => {
              // 1ª leitura: a trava; 2ª: a pré-condição; 3ª e 4ª: a escrita de habilitar; 5ª: a leitura de depois.
              // Antes dela entra um dado.
              if (/acervo\.ambiente/.test(sql) && ++ambientes === 5) {
                const id = (
                  await dono.query<{ id: string }>(
                    'select id::text as id from auth."user" where email = $1',
                    [e],
                  )
                ).rows[0]?.id as string;
                await darAceite(id, "entrou-no-intervalo");
              }
              return query(sql, p);
            },
          } as never,
        };
      },
    });
    usuarios.push(e);
    await expect(x.preparar(["estudante"])).rejects.toThrow(/PreCondicao.*1 linha/);
    expect(x.registro.preparado).toBe(false);
    await x.finalizar();
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1); // o fim desabilitou o que habilitou
  });

  it("instância de uso único: depois de finalizar, preparar, finalizar e sessão lançam erro e nada é apagado", async () => {
    const e = novoEmail("uso-unico");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real11");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const x = new ExecucaoCanario(fabricaLocal());
    await x.preparar(["estudante"]);
    const id = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    usuarios.push(e);
    await x.finalizar();
    // Linha que NÃO é desta execução, escrita depois do fim (por exemplo, pelo dono à mão).
    await darAceite(id, "do-dono-depois");
    await expect(x.preparar(["estudante"])).rejects.toBeInstanceOf(ExecucaoEncerrada);
    await expect(x.finalizar()).rejects.toBeInstanceOf(ExecucaoEncerrada);
    await expect(x.criarSessao("estudante")).rejects.toBeInstanceOf(ExecucaoEncerrada);
    await expect(x.encerrarSessao(randomUUID())).rejects.toBeInstanceOf(ExecucaoEncerrada);
    expect(await consentimentos(id)).toBe(1);
  });

  it("preparar roda uma vez, e o que recusa deixa preparado=false", async () => {
    const e = novoEmail("uma-vez");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real12");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const id = await criarConta(e);
    await darAceite(id, "previa");
    const x = new ExecucaoCanario(fabricaLocal());
    await expect(x.preparar(["estudante"])).rejects.toThrow(/PreCondicao/);
    expect(x.registro.preparado).toBe(false);
    await expect(x.preparar(["estudante"])).rejects.toBeInstanceOf(ExecucaoEncerrada);
    await x.finalizar();
    expect(await consentimentos(id)).toBe(1);
  });

  it("execução completa: conta chega vazia, sessão registrada, tudo apagado ao fim, desabilitada e trava solta", async () => {
    const e = novoEmail("completo");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real6");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const x = new ExecucaoCanario(fabricaLocal());
    await criarConta(e);
    await x.preparar(["estudante"]);
    expect(x.registro.preparado).toBe(true);
    const s = await x.criarSessao("estudante");
    expect(await contar("select count(*) as n from auth.session where id = $1", [s.id])).toBe(1);
    await darAceite(s.usuarioId, "desta-execucao");
    await dono.query(
      "insert into privado.sessao (estudante_id, check_in_em, estudo_inicio_id) values ($1, now(), $2)",
      [s.usuarioId, ESTUDO_DE_TESTE.id],
    ); // Sessão aberta, sem Anotação: entra na limpeza como qualquer linha
    await x.finalizar();
    expect(
      await contar("select count(*) as n from auth.session where user_id = $1", [s.usuarioId]),
    ).toBe(0);
    expect((await contarLinhasPrivadas(dono, s.usuarioId)).total).toBe(0);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1);
    await expect(x.encerrarSessao(randomUUID())).rejects.toBeInstanceOf(RecusaCanario);
    const y = new ExecucaoCanario(fabricaLocal());
    await y.preparar(["estudante"]); // trava solta: a próxima execução toma
    await y.finalizar();
  });
});
