import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { recuperarSegundoFator } from "../../scripts/admin/recuperar-segundo-fator";
import { semearAdmin } from "../../scripts/admin/semear-admin";
import { convidar } from "../../src/modules/identidade/convite";
import { emailsPara, ultimoEmailPara } from "./caixa-de-email";

const executar = promisify(execFile);

// Endereço único por teste, sob domínio reservado.
export function emailDeTeste(prefixo = "estudante"): string {
  return `${prefixo}-${randomBytes(5).toString("hex")}@convite.example`;
}

// Convida pela MESMA função que o comando `pnpm convidar` chama (`convidar`), no processo do teste:
// a partida de `pnpm exec tsx` custava de 1 a 5 s por convite e dominava o tempo dos testes. O
// comando em si (leitura do endereço pela variável, mensagens) é exercitado por `convidarPelaCLI`.
export async function convidarParaTeste(endereco: string): Promise<void> {
  await convidar(endereco, null);
}

// Convida pelo comando de verdade, no banco da execução. O endereço vai por variável de ambiente.
export async function convidarPelaCLI(endereco: string): Promise<void> {
  await executar(
    "pnpm",
    ["exec", "tsx", "scripts/admin/convidar.ts", "--variavel", "JNF_EMAIL_TESTE"],
    {
      env: { ...process.env, JNF_EMAIL_TESTE: endereco },
    },
  );
}

// Cada contexto tem o seu IP de teste: os limites por IP não podem ligar testes paralelos.
export async function isolarIp(page: Page): Promise<void> {
  const [a, b, c] = [1, 2, 3].map(() => 1 + Math.floor(Math.random() * 250));
  await page.context().setExtraHTTPHeaders({ "x-real-ip": `10.${a}.${b}.${c}` });
}

export async function pedirAcesso(page: Page, endereco: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco);
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
}

export async function entrarPorLink(
  page: Page,
  endereco: string,
  chegada = "Trilhas",
): Promise<void> {
  await isolarIp(page);
  // O e-mail sai depois da resposta: sem esperar por UM A MAIS do que já havia, uma segunda entrada
  // do mesmo endereço pegaria o link da primeira (já gasto) quando o novo ainda não chegou.
  const jaEnviados = emailsPara(endereco).filter((m) => /acesso/i.test(m.assunto)).length;
  await pedirAcesso(page, endereco);
  const { link } = await ultimoEmailPara(endereco, { depoisDe: jaEnviados });
  if (!link) throw new Error("O e-mail não trouxe o link");
  await page.goto(link);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: chegada }).waitFor();
}

// Semeia um Admin no banco da execução pela função de `admin:semear` (a do comando), sem e-mail de
// convite e sem partir um processo novo. O estado de cada caso (criar, promover, recusar revogado)
// é provado nos testes de integração de `semearAdmin`.
export async function semearAdminParaTeste(endereco: string): Promise<void> {
  const r = await semearAdmin(endereco);
  if (r.codigo !== 0) throw new Error(`semearAdmin recusou: ${r.mensagem}`);
}

// Recuperação do segundo fator, pela função do script do dono do banco, nas duas etapas: a prévia
// devolve o id e a escrita só vale com esse id. Devolve a mensagem da escrita (nunca traz o endereço).
export async function recuperarSegundoFatorParaTeste(endereco: string): Promise<string> {
  const previa = await recuperarSegundoFator(endereco);
  const id = /^id: ([0-9a-f-]{36})$/m.exec(previa.mensagem)?.[1];
  if (previa.codigo !== 0 || !id) throw new Error("A prévia da recuperação não devolveu o id.");
  const feita = await recuperarSegundoFator(endereco, { executar: true, id });
  if (feita.codigo !== 0) throw new Error(`A recuperação recusou: ${feita.mensagem}`);
  return feita.mensagem;
}

// Zera os limites de PEDIDO de acesso (por e-mail e por IP) no banco da execução, para um teste que
// precisa de mais entradas por endereço do que o limite permite. Não toca nos limites do segundo fator.
export async function liberarLimitesDePedido(): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    await c.query("delete from admin.tentativa where chave like 'pedido-%'");
  } finally {
    await c.end();
  }
}

// Escrita direta no banco da execução (como dono), para semear um estado que o teste vai exercitar.
export async function escrever(consulta: string, parametros: string[] = []): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    await c.query(consulta, parametros);
  } finally {
    await c.end();
  }
}

export async function idDoUsuario(endereco: string): Promise<string> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    const r = await c.query<{ id: string }>('select id from auth."user" where email = $1', [
      endereco.toLowerCase(),
    ]);
    return r.rows[0]?.id as string;
  } finally {
    await c.end();
  }
}

// Leitura de contagem direto no banco da execução (como dono; só para conferir o que ficou gravado).
export async function contar(consulta: string, parametros: string[] = []): Promise<number> {
  const { default: pg } = await import("pg");
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    const resultado = await cliente.query<{ n: string }>(consulta, parametros);
    return Number(resultado.rows[0]?.n);
  } finally {
    await cliente.end();
  }
}

export async function convidarVarios(enderecos: string[]): Promise<void> {
  for (let i = 0; i < enderecos.length; i += 5) {
    await Promise.all(enderecos.slice(i, i + 5).map((e) => convidarParaTeste(e)));
  }
}

// Linhas que guardam algo daquele endereço: contas, convites e verificações (link e código).
export async function linhasDe(endereco: string) {
  const email = endereco.toLowerCase();
  const verificacoes = await contar(
    "select count(*) as n from auth.verification where identifier = $1 or value like $2",
    [`sign-in-otp-${email}`, `%${email}%`],
  );
  const usuarios = await contar('select count(*) as n from auth."user" where email = $1', [email]);
  const convites = await contar("select count(*) as n from admin.convite where email_norm = $1", [
    email,
  ]);
  return { verificacoes, usuarios, convites };
}

export async function revogarConviteNoBanco(endereco: string): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    await c.query(
      "update admin.convite set estado = 'revogado', revogado_em = now() where email_norm = $1",
      [endereco.toLowerCase()],
    );
  } finally {
    await c.end();
  }
}

// Linhas de sessão que existem no banco para aquele endereço.
export const sessoesDe = (endereco: string) =>
  contar(
    'select count(*) as n from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1',
    [endereco.toLowerCase()],
  );

// Convida muitos endereços de uma vez direto no banco (mesmo efeito de `convidar`, sem e-mail de
// convite): só para as medições de tempo, que precisam de centenas de endereços convidados.
export async function convidarEmLote(enderecos: string[]): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    const emails = enderecos.map((e) => e.toLowerCase());
    await c.query(
      "insert into auth.\"user\" (email, role) select unnest($1::text[]), 'estudante' on conflict do nothing",
      [emails],
    );
    await c.query(
      "insert into admin.convite (email_norm, estado) select unnest($1::text[]), 'pendente' on conflict do nothing",
      [emails],
    );
  } finally {
    await c.end();
  }
}
