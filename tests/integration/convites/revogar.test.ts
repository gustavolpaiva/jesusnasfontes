import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterPool } from "@/db/cliente";
import {
  chaveDoReenvio,
  reenviarConviteNucleo,
  revogarConviteNucleo,
} from "@/modules/convites/operacoes";
import { aceitarConvite, convidar, conviteAtivo } from "@/modules/identidade/convite";
import { CHAVE_TRAVA_DE_ADMINS } from "@/modules/privacidade/remover-conta";
import { criarBancoPreparado, removerBancoDeExecucao } from "../../support/banco-local";

// Revogar e reenviar convites (AUTH-06). Cria contas, sessões e dados privados, então roda num banco
// descartável só deste arquivo (nunca no banco compartilhado, nunca no Neon). O e-mail vai para o
// transporte em arquivo, numa pasta temporária: nenhuma mensagem real.

let banco: Awaited<ReturnType<typeof criarBancoPreparado>>["banco"];
let env: Record<string, string>;
let pastaDeEmail: string;
let dono: pg.Client;

const novo = (prefixo: string) => `${prefixo}-${randomBytes(5).toString("hex")}@convite.example`;
// O transporte em arquivo nomeia cada mensagem com um resumo do endereço de destino.
const destino = (para: string) => createHash("sha256").update(para).digest("hex").slice(0, 16);
const emailsEnviados = (para: string): number =>
  readdirSync(pastaDeEmail).filter((n) => n.endsWith(".json") && n.includes(destino(para))).length;

beforeAll(async () => {
  const criado = await criarBancoPreparado();
  banco = criado.banco;
  env = criado.env;
  Object.assign(process.env, env);
  pastaDeEmail = mkdtempSync(join(tmpdir(), "jnf-convites-"));
  process.env.MAIL_TRANSPORT = "arquivo";
  process.env.MAIL_DIR = pastaDeEmail;
  dono = new pg.Client({ connectionString: env.DATABASE_URL_OWNER });
  await dono.connect();
});

afterAll(async () => {
  await dono?.end();
  await obterPool().end();
  await removerBancoDeExecucao(banco.nome);
  rmSync(pastaDeEmail, { recursive: true, force: true });
});

type Pessoa = { id: string; email: string; conviteId: string };

async function convidarPessoa(
  prefixo: string,
  opcoes: { papel?: "estudante" | "admin"; aceito?: boolean } = {},
): Promise<Pessoa> {
  const email = novo(prefixo);
  await convidar(email, null, { papel: opcoes.papel, enviar: false });
  if (opcoes.aceito) await aceitarConvite(email);
  const u = await dono.query<{ id: string }>('select id from auth."user" where email = $1', [
    email,
  ]);
  const c = await dono.query<{ id: string }>("select id from admin.convite where email_norm = $1", [
    email,
  ]);
  return { id: u.rows[0]?.id as string, email, conviteId: c.rows[0]?.id as string };
}

async function abrirSessoes(p: Pessoa, quantas = 2): Promise<void> {
  for (let i = 0; i < quantas; i++) {
    await dono.query(
      `insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '1 day')`,
      [p.id, randomUUID()],
    );
  }
}

async function semearDados(p: Pessoa): Promise<void> {
  await dono.query(
    "insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, gen_random_uuid(), $2)",
    [p.id, `corpo de ${p.email}`],
  );
  // Um código de entrada e um link pendentes daquele endereço.
  await dono.query(
    `insert into auth.verification (identifier, value, expires_at) values ($1, '123456:0', now() + interval '10 minutes')`,
    [`sign-in-otp-${p.email}`],
  );
  await dono.query(
    `insert into auth.verification (identifier, value, expires_at) values ($1, $2, now() + interval '10 minutes')`,
    [`magic-link:${randomUUID()}`, JSON.stringify({ type: "magic-link", email: p.email })],
  );
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

// Espera até `n` consultas do banco deste teste estarem paradas numa trava.
async function esperarBloqueios(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await dono.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if ((r.rows[0]?.n ?? 0) >= n) return;
    await dormir(50);
  }
  throw new Error("Nenhuma revogação ficou esperando a trava: o teste não provou a espera.");
}

const contagem = async (consulta: string, parametros: unknown[]) =>
  Number((await dono.query<{ n: string }>(consulta, parametros)).rows[0]?.n);
const sessoes = (p: Pessoa) =>
  contagem("select count(*) as n from auth.session where user_id = $1", [p.id]);
const anotacoes = (p: Pessoa) =>
  contagem("select count(*) as n from privado.anotacao where estudante_id = $1", [p.id]);
const verificacoes = (p: Pessoa) =>
  contagem("select count(*) as n from auth.verification where identifier = $1 or value like $2", [
    `sign-in-otp-${p.email}`,
    `%${p.email}%`,
  ]);
const usuarios = (p: Pessoa) =>
  contagem('select count(*) as n from auth."user" where email = $1', [p.email]);
const estadoDe = async (p: Pessoa) =>
  (
    await dono.query<{ estado: string; revogado_em: Date | null }>(
      "select estado, revogado_em from admin.convite where id = $1",
      [p.conviteId],
    )
  ).rows[0];

describe("revogarConviteNucleo", () => {
  it("Aceito: encerra todas as sessões e os códigos pendentes, mantém conta e dados, e a vizinha fica como estava", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const alvo = await convidarPessoa("aceito", { aceito: true });
    const vizinho = await convidarPessoa("vizinho", { aceito: true });
    for (const p of [alvo, vizinho]) {
      await abrirSessoes(p, 2);
      await semearDados(p);
    }
    // Controle positivo: antes, a pessoa entra (convite ativo) e tem o que será medido.
    expect(await conviteAtivo(alvo.email)).toBe(true);
    expect(await sessoes(alvo)).toBe(2);

    const r = await revogarConviteNucleo(alvo.conviteId, admin.id);
    expect(r).toEqual({ ok: true, email: alvo.email, sessoesEncerradas: 2, contaApagada: false });

    expect(await conviteAtivo(alvo.email)).toBe(false);
    const e = await estadoDe(alvo);
    expect(e?.estado).toBe("revogado");
    expect(e?.revogado_em).not.toBeNull();
    expect(await sessoes(alvo)).toBe(0);
    expect(await verificacoes(alvo)).toBe(0);
    // Os dados de quem já entrou ficam.
    expect(await usuarios(alvo)).toBe(1);
    expect(await anotacoes(alvo)).toBe(1);
    // Controle negativo: o convite vizinho, as sessões, os dados e os códigos dele não mudam.
    expect(await conviteAtivo(vizinho.email)).toBe(true);
    expect((await estadoDe(vizinho))?.estado).toBe("aceito");
    expect(await sessoes(vizinho)).toBe(2);
    expect(await anotacoes(vizinho)).toBe(1);
    expect(await verificacoes(vizinho)).toBe(2);
    expect(await usuarios(vizinho)).toBe(1);
  });

  it("Pendente nunca aceito: a conta vazia sai junto, a vizinha fica, e o mesmo e-mail pode ser convidado de novo", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const alvo = await convidarPessoa("pendente");
    const vizinho = await convidarPessoa("pendente-vizinho");
    expect(await usuarios(alvo)).toBe(1);

    const r = await revogarConviteNucleo(alvo.conviteId, admin.id);
    expect(r).toEqual({ ok: true, email: alvo.email, sessoesEncerradas: 0, contaApagada: true });
    expect(await usuarios(alvo)).toBe(0);
    expect(await conviteAtivo(alvo.email)).toBe(false);
    expect((await estadoDe(alvo))?.estado).toBe("revogado");
    expect(await usuarios(vizinho)).toBe(1);
    expect(await conviteAtivo(vizinho.email)).toBe(true);

    // Convidar de novo reativa o convite e recria a conta.
    await convidar(alvo.email, null, { enviar: false });
    expect(await conviteAtivo(alvo.email)).toBe(true);
    expect(await usuarios(alvo)).toBe(1);
  });

  it("convite Pendente de quem já entrou antes (reconvidado) mantém a conta e os dados", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const alvo = await convidarPessoa("reconvidado", { aceito: true });
    await semearDados(alvo);
    await revogarConviteNucleo(alvo.conviteId, admin.id);
    await convidar(alvo.email, null, { enviar: false });
    expect((await estadoDe(alvo))?.estado).toBe("pendente");

    const r = await revogarConviteNucleo(alvo.conviteId, admin.id);
    expect(r).toMatchObject({ ok: true, contaApagada: false });
    expect(await usuarios(alvo)).toBe(1);
    expect(await anotacoes(alvo)).toBe(1);
  });

  it("Pendente com sessão aberta (sinal de que a pessoa entrou) também mantém a conta", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const alvo = await convidarPessoa("sinal");
    await abrirSessoes(alvo, 1);
    const r = await revogarConviteNucleo(alvo.conviteId, admin.id);
    expect(r).toMatchObject({ ok: true, sessoesEncerradas: 1, contaApagada: false });
    expect(await usuarios(alvo)).toBe(1);
    expect(await sessoes(alvo)).toBe(0);
  });

  it("recusa o próprio convite de quem revoga, sem tocar em nada", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const outro = await convidarPessoa("outro-admin", { papel: "admin", aceito: true });
    await abrirSessoes(admin, 2);
    const r = await revogarConviteNucleo(admin.conviteId, admin.id);
    expect(r).toEqual({ ok: false, erro: "proprio" });
    expect((await estadoDe(admin))?.estado).toBe("aceito");
    expect(await sessoes(admin)).toBe(2);
    expect(await usuarios(admin)).toBe(1);
    expect(outro.id).not.toBe(admin.id);
  });

  it("recusa o convite do único Admin com convite ativo; com outro Admin ativo, revoga", async () => {
    // Sem outro Admin ativo: o ator é uma conta que não é Admin (a ação real nunca chega aqui, a guarda
    // barra antes; a verificação é a segunda camada).
    const unico = await convidarPessoa("unico", { papel: "admin", aceito: true });
    const estudante = await convidarPessoa("ator-estudante", { aceito: true });
    // Admins de outros testes deste arquivo têm convite ativo e contariam como "outro": usa-se um
    // banco onde só este Admin existe é impossível aqui, então o teste revoga os demais antes.
    await dono.query(
      `update admin.convite set estado = 'revogado', revogado_em = now()
       where email_norm in (select email from auth."user" where role = 'admin' and id <> $1)`,
      [unico.id],
    );
    const recusado = await revogarConviteNucleo(unico.conviteId, estudante.id);
    expect(recusado).toEqual({ ok: false, erro: "unico-admin" });
    expect((await estadoDe(unico))?.estado).toBe("aceito");

    // Controle positivo: com um segundo Admin ativo, o mesmo pedido passa.
    await convidarPessoa("segundo-admin", { papel: "admin", aceito: true });
    const aceito = await revogarConviteNucleo(unico.conviteId, estudante.id);
    expect(aceito).toMatchObject({ ok: true });
  });

  it("dois Admins que se revogam ao mesmo tempo esperam a trava dos Admins; só um vence e o grupo nunca fica sem Admin", async () => {
    await dono.query(
      `update admin.convite set estado = 'revogado', revogado_em = now()
       where email_norm in (select email from auth."user" where role = 'admin')`,
    );
    const a = await convidarPessoa("par-a", { papel: "admin", aceito: true });
    const b = await convidarPessoa("par-b", { papel: "admin", aceito: true });

    // Segura a trava dos Admins (a mesma de apagar a conta) numa conexão à parte. As duas revogações
    // têm de parar nela: sem a trava, elas correriam juntas e o teste falharia por não achar espera.
    const trava = new pg.Client({ connectionString: env.DATABASE_URL_OWNER });
    await trava.connect();
    await trava.query("begin");
    await trava.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      CHAVE_TRAVA_DE_ADMINS,
    ]);
    let terminadas = 0;
    const duas = Promise.all([
      revogarConviteNucleo(b.conviteId, a.id),
      revogarConviteNucleo(a.conviteId, b.id),
    ]).then((r) => {
      terminadas = 2;
      return r;
    });
    await esperarBloqueios(2);
    await dormir(150);
    expect(terminadas).toBe(0);
    await trava.query("commit");
    await trava.end();

    const resultados = await duas;
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.filter((r) => !r.ok)).toEqual([{ ok: false, erro: "unico-admin" }]);
    const ativos = await contagem(
      `select count(*) as n from admin.convite c join auth."user" u on u.email = c.email_norm
       where u.role = 'admin' and c.estado in ('pendente','aceito') and u.id in ($1, $2)`,
      [a.id, b.id],
    );
    expect(ativos).toBe(1);
  });

  it("convite já revogado e ID inexistente: recusa sem efeito", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const alvo = await convidarPessoa("duas-vezes", { aceito: true });
    await revogarConviteNucleo(alvo.conviteId, admin.id);
    expect(await revogarConviteNucleo(alvo.conviteId, admin.id)).toEqual({
      ok: false,
      erro: "estado",
    });
    expect(await revogarConviteNucleo(randomUUID(), admin.id)).toEqual({
      ok: false,
      erro: "inexistente",
    });
  });
});

describe("reenviarConviteNucleo", () => {
  it("só reenvia Pendente; Aceito e Revogado são recusados e nada sai", async () => {
    const admin = await convidarPessoa("admin", { papel: "admin", aceito: true });
    const pendente = await convidarPessoa("reenvio-pendente");
    const aceito = await convidarPessoa("reenvio-aceito", { aceito: true });
    const revogado = await convidarPessoa("reenvio-revogado", { aceito: true });
    await revogarConviteNucleo(revogado.conviteId, admin.id);

    const ok = await reenviarConviteNucleo(pendente.conviteId);
    expect(ok).toEqual({ ok: true, email: pendente.email, emailSaiu: true });
    expect(emailsEnviados(pendente.email)).toBe(1);

    expect(await reenviarConviteNucleo(aceito.conviteId)).toEqual({ ok: false, erro: "estado" });
    expect(await reenviarConviteNucleo(revogado.conviteId)).toEqual({ ok: false, erro: "estado" });
    expect(await reenviarConviteNucleo(randomUUID())).toEqual({ ok: false, erro: "inexistente" });
    expect(emailsEnviados(aceito.email)).toBe(0);
    expect(emailsEnviados(revogado.email)).toBe(0);
  });

  it("limite de 3 reenvios por convite por hora: o quarto é recusado sem e-mail, e o convite vizinho segue livre", async () => {
    const alvo = await convidarPessoa("limite");
    const vizinho = await convidarPessoa("limite-vizinho");
    for (let i = 0; i < 3; i++) {
      expect(await reenviarConviteNucleo(alvo.conviteId)).toMatchObject({ ok: true });
    }
    expect(emailsEnviados(alvo.email)).toBe(3);
    expect(await reenviarConviteNucleo(alvo.conviteId)).toEqual({ ok: false, erro: "limite" });
    expect(emailsEnviados(alvo.email)).toBe(3);
    // Controle negativo: o vizinho não herdou o contador.
    expect(await reenviarConviteNucleo(vizinho.conviteId)).toMatchObject({ ok: true });
    expect(emailsEnviados(vizinho.email)).toBe(1);
    const chaves = await contagem("select count(*) as n from admin.tentativa where chave = $1", [
      chaveDoReenvio(alvo.conviteId),
    ]);
    expect(chaves).toBe(1);
  });
});
