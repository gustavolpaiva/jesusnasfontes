import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { desabilitar, habilitar } from "../../../scripts/dev/canario";
import { ExecucaoCanario, type Fabrica } from "../../../scripts/dev/execucao-canario";
import {
  AlvoAMais,
  fotografar,
  limpar,
  TETO_POR_TABELA,
} from "../../../scripts/dev/limpeza-canario";
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

const fabricaLocal = (): Fabrica => ({
  pool: () => obterPool(),
  dono: async () => {
    const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await cliente.connect();
    return { cliente, fechar: () => cliente.end() };
  },
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
    await expect(fotografar(prod as never, id)).rejects.toThrow(/RecusaDeAmbiente/);
    await expect(limpar(prod as never, id, [], "m")).rejects.toThrow(/RecusaDeAmbiente/);
    // Só a leitura do marcador, nenhuma escrita nem transação.
    expect(consultas.every((s) => /^select nome from acervo\.ambiente/.test(s))).toBe(true);
    expect(consultas.length).toBe(4);
  });
});

describe.skipIf(emNeon())("limpeza só do que a execução criou", () => {
  it("apaga as linhas novas e preserva a que a conta já tinha", async () => {
    const e = novoEmail("limpa");
    const id = await criarConta(e);
    await darAceite(id, "ja-existia");
    const foto = await fotografar(dono, id);
    await darAceite(id, "novo-1");
    await darAceite(id, "novo-2");
    const apagadas = await limpar(dono, id, foto, "marca-x");
    expect(apagadas).toEqual({ consentimento: 2 });
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from privado.consentimento where estudante_id = $1 and versao_aviso = 'ja-existia'",
        [id],
      ),
    ).toBe(1);
  });

  it("mais alvo que o teto: aborta sem escrever", async () => {
    const id = await criarConta(novoEmail("teto"));
    const foto = await fotografar(dono, id);
    // O teto é pequeno de propósito (o teste não pode passar com um teto frouxo).
    expect(TETO_POR_TABELA).toBeLessThanOrEqual(10);
    for (let i = 0; i < 11; i++) await darAceite(id, `v${i}`);
    await expect(limpar(dono, id, foto, "marca-x")).rejects.toBeInstanceOf(AlvoAMais);
    expect(await consentimentos(id)).toBe(11);
  });

  it("linha nova de texto sem a marca da execução: aborta sem escrever, com a marca apaga", async () => {
    const id = await criarConta(novoEmail("marca"));
    const foto = await fotografar(dono, id);
    await darAceite(id, "novo");
    await dono.query(
      "insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, $2, 'texto de outra origem')",
      [id, ESTUDO_DE_TESTE.id],
    );
    await expect(limpar(dono, id, foto, "MARCA-DA-EXECUCAO")).rejects.toThrow(/RecusaDeMarca/);
    expect(await consentimentos(id)).toBe(1); // nem a linha sem marca nem a outra foram apagadas
    expect(
      await contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]),
    ).toBe(1);
    await dono.query(
      "update privado.anotacao set corpo = 'escrito com MARCA-DA-EXECUCAO' where estudante_id = $1",
      [id],
    );
    const apagadas = await limpar(dono, id, foto, "MARCA-DA-EXECUCAO");
    expect(apagadas).toMatchObject({ anotacao: 1, consentimento: 1 });
    expect(await consentimentos(id)).toBe(0);
  });

  it("não toca linha de outra conta", async () => {
    const a = await criarConta(novoEmail("a"));
    const b = await criarConta(novoEmail("b"));
    const foto = await fotografar(dono, a);
    await darAceite(a, "da-a");
    await darAceite(b, "da-b");
    await limpar(dono, a, foto, "m");
    expect(await consentimentos(a)).toBe(0);
    expect(await consentimentos(b)).toBe(1);
  });
});

describe.skipIf(emNeon())("execução de canário: preparação autorizada e concluída", () => {
  it("execução que nunca preparou não escreve nada ao finalizar", async () => {
    const abriu = vi.fn();
    const fabrica = fabricaLocal();
    const x = new ExecucaoCanario({
      pool: fabrica.pool,
      dono: async () => {
        abriu();
        return fabrica.dono();
      },
    });
    await x.finalizar();
    expect(abriu).not.toHaveBeenCalled();
  });

  it("preparação recusada (canário é o Admin inicial) não habilita nem apaga nada", async () => {
    const real = novoEmail("real4");
    const idReal = await criarConta(real, "admin");
    await darAceite(idReal, "do-admin-real");
    process.env.ADMIN_EMAIL_INICIAL = real;
    process.env.JNF_CANARIO_ADMIN_EMAIL = real;
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = novoEmail("est5");
    const x = new ExecucaoCanario(fabricaLocal());
    await expect(x.preparar(["estudante", "admin"])).rejects.toBeInstanceOf(RecusaCanario);
    expect(x.registro.habilitados).toEqual([]);
    await x.finalizar(); // o fim também não escreve: nada foi autorizado
    expect(await consentimentos(idReal)).toBe(1);
    expect(
      await contar("select count(*) as n from admin.convite where email_norm = $1", [real]),
    ).toBe(0);
    await expect(x.criarSessao("admin")).rejects.toBeInstanceOf(RecusaCanario);
  });

  it("preparação que não concluiu (uma conta já fotografada): o fim desabilita mas NÃO apaga linhas privadas", async () => {
    const e = novoEmail("meio");
    const eAdmin = novoEmail("meio-admin");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real5");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    process.env.JNF_CANARIO_ADMIN_EMAIL = eAdmin;
    usuarios.push(e, eAdmin);
    const base = fabricaLocal();
    let chamadas = 0;
    const x = new ExecucaoCanario({
      pool: base.pool,
      dono: async () => {
        chamadas++;
        // 1ª: conferência inicial; 2ª: o estudante, depois de habilitar (fotografado); 3ª: o Admin (falha).
        if (chamadas === 3) throw new Error("falha simulada na preparação");
        return base.dono();
      },
    });
    await expect(x.preparar(["estudante", "admin"])).rejects.toThrow(/falha simulada/);
    expect(x.registro.preparado).toBe(false);
    expect(x.registro.fotografados).toEqual(["estudante"]);
    const idConta = (
      await dono.query<{ id: string }>('select id::text as id from auth."user" where email = $1', [
        e,
      ])
    ).rows[0]?.id as string;
    await darAceite(idConta, "escrita-depois-da-foto"); // nova em relação à foto, mas a execução não concluiu
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
    // Entre o começo e o fim o ambiente passou a apontar o canário para outro endereço.
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = novoEmail("trocado");
    await expect(x.finalizar()).rejects.toThrow(/RecusaDeConta/);
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado <> 'revogado'",
        [e],
      ),
    ).toBe(1);
    // Restabelecido o marcado, o fim conclui normalmente.
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    await x.finalizar();
    expect(await consentimentos(id)).toBe(0);
  });

  it("execução completa: sessão registrada, linha nova apagada, pré-existente preservada, desabilitado ao fim", async () => {
    const e = novoEmail("completo");
    process.env.ADMIN_EMAIL_INICIAL = novoEmail("real6");
    process.env.JNF_CANARIO_ESTUDANTE_EMAIL = e;
    const x = new ExecucaoCanario(fabricaLocal());
    // A conta existe antes, com uma linha que NÃO é desta execução.
    const id = await criarConta(e);
    await darAceite(id, "ja-existia");
    await x.preparar(["estudante"]);
    expect(x.registro.preparado).toBe(true);
    const s = await x.criarSessao("estudante");
    expect(await contar("select count(*) as n from auth.session where id = $1", [s.id])).toBe(1);
    await darAceite(id, "desta-execucao");
    await x.finalizar();
    expect(await contar("select count(*) as n from auth.session where user_id = $1", [id])).toBe(0);
    expect(
      await contar(
        "select count(*) as n from privado.consentimento where estudante_id = $1 and versao_aviso = 'ja-existia'",
        [id],
      ),
    ).toBe(1);
    expect(await consentimentos(id)).toBe(1);
    expect(
      await contar(
        "select count(*) as n from admin.convite where email_norm = $1 and estado = 'revogado'",
        [e],
      ),
    ).toBe(1);
    // Sessão que a execução não abriu não se encerra por aqui.
    await expect(x.encerrarSessao(randomUUID())).rejects.toBeInstanceOf(RecusaCanario);
  });
});
