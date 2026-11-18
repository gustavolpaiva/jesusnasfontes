import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { prepararBanco } from "./preparar-banco";

// Postgres 17 local e descartável. Cada execução cria um banco próprio dentro do mesmo contêiner,
// para que execuções simultâneas (de planos diferentes) não compartilhem estado.

const CONTEINER = "jnf-pg17";
// Porta única do Postgres local de teste (a 54329 costuma estar ocupada por encaminhamento de portas).
export const PORTA_BANCO_LOCAL = 54331;
const PORTA = PORTA_BANCO_LOCAL;
const ADMIN_URL = `postgres://postgres@127.0.0.1:${PORTA}/postgres`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function estadoDoConteiner(): "ausente" | "rodando" | "parado" {
  try {
    const saida = docker("inspect", "-f", "{{.State.Running}}", CONTEINER).trim();
    return saida === "true" ? "rodando" : "parado";
  } catch {
    return "ausente";
  }
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

async function aguardarPronto(limiteMs = 90_000): Promise<void> {
  const inicio = Date.now();
  let ultimoErro = "";
  while (Date.now() - inicio < limiteMs) {
    const cliente = new pg.Client({ connectionString: ADMIN_URL });
    try {
      await cliente.connect();
      await cliente.query("select 1");
      await cliente.end();
      return;
    } catch (erro) {
      ultimoErro = erro instanceof Error ? erro.message : String(erro);
      await cliente.end().catch(() => {});
      await dormir(500);
    }
  }
  throw new Error(`Postgres local não respondeu em ${limiteMs} ms: ${ultimoErro}`);
}

export async function garantirConteiner(): Promise<void> {
  const estado = estadoDoConteiner();
  if (estado === "parado") {
    docker("start", CONTEINER);
  } else if (estado === "ausente") {
    try {
      docker(
        "run",
        "-d",
        "--name",
        CONTEINER,
        "-p",
        `127.0.0.1:${PORTA}:5432`,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres:17",
      );
    } catch (erro) {
      // Outra execução pode ter criado o contêiner no mesmo instante: então basta reaproveitá-lo.
      if (estadoDoConteiner() === "ausente") throw erro;
    }
  }
  await aguardarPronto();
}

export type BancoDeExecucao = { nome: string; url: string };

// Nomes de banco criados POR ESTE processo. Só eles podem ser removidos.
const criadosNestaExecucao = new Set<string>();

// Trava: operações destrutivas só contra o contêiner local (host e porta da constante), seja qual
// for a configuração do ambiente (ALVO_BANCO, DATABASE_URL_OWNER do cofre). Falha antes de conectar.
export function assegurarConexaoLocal(urlAdmin: string): void {
  let alvo: URL;
  try {
    alvo = new URL(urlAdmin);
  } catch {
    throw new Error("Recusado: conexão administrativa ilegível; só o contêiner local é aceito.");
  }
  const hostLocal = alvo.hostname === "127.0.0.1" || alvo.hostname === "localhost";
  if (!hostLocal || Number(alvo.port) !== PORTA_BANCO_LOCAL) {
    throw new Error("Recusado: operação destrutiva apenas no contêiner local de teste.");
  }
}

export async function criarBancoDeExecucao(): Promise<BancoDeExecucao> {
  assegurarConexaoLocal(ADMIN_URL);
  await garantirConteiner();
  const nome = `teste_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database "${nome}"`);
    criadosNestaExecucao.add(nome);
  } finally {
    await admin.end();
  }
  return { nome, url: `postgres://postgres@127.0.0.1:${PORTA}/${nome}` };
}

export async function removerBancoDeExecucao(
  nome: string,
  urlAdmin: string = ADMIN_URL,
): Promise<void> {
  assegurarConexaoLocal(urlAdmin);
  if (!/^teste_\d+_[0-9a-f]{8}$/.test(nome) || !criadosNestaExecucao.has(nome)) {
    throw new Error(
      "Recusado: só se remove banco criado por esta execução de criarBancoDeExecucao",
    );
  }
  const admin = new pg.Client({ connectionString: urlAdmin });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${nome}" with (force)`);
    criadosNestaExecucao.delete(nome);
  } finally {
    await admin.end();
  }
}

// Cria e prepara o banco da execução. Se a preparação falhar, o banco recém-criado é removido
// antes de propagar o erro: nenhum banco teste_* órfão.
export async function criarBancoPreparado(
  preparar: (banco: BancoDeExecucao) => Promise<Record<string, string>> = prepararBanco,
): Promise<{ banco: BancoDeExecucao; env: Record<string, string> }> {
  const banco = await criarBancoDeExecucao();
  try {
    return { banco, env: await preparar(banco) };
  } catch (erro) {
    await removerBancoDeExecucao(banco.nome).catch(() => {});
    throw erro;
  }
}

// Ponto de entrada do globalSetup do Vitest (projeto de integração).
export async function setup(projeto: {
  provide: (chave: "urlBancoExecucao" | "alvoBanco" | "envBancoExecucao", valor: string) => void;
}) {
  const alvo = process.env.ALVO_BANCO === "neon" ? "neon" : "local";
  projeto.provide("alvoBanco", alvo);
  if (alvo === "neon") {
    projeto.provide("urlBancoExecucao", "");
    projeto.provide("envBancoExecucao", "{}");
    return;
  }
  const { banco, env } = await criarBancoPreparado();
  nomeCriado = banco.nome;
  projeto.provide("urlBancoExecucao", banco.url);
  projeto.provide("envBancoExecucao", JSON.stringify(env));
}

let nomeCriado: string | undefined;

export async function teardown() {
  if (nomeCriado) await removerBancoDeExecucao(nomeCriado);
}

declare module "vitest" {
  export interface ProvidedContext {
    urlBancoExecucao: string;
    envBancoExecucao: string;
    alvoBanco: "local" | "neon";
  }
}
