import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

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

export async function criarBancoDeExecucao(): Promise<BancoDeExecucao> {
  await garantirConteiner();
  const nome = `teste_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database "${nome}"`);
  } finally {
    await admin.end();
  }
  return { nome, url: `postgres://postgres@127.0.0.1:${PORTA}/${nome}` };
}

export async function removerBancoDeExecucao(nome: string): Promise<void> {
  if (!/^teste_\d+_[0-9a-f]{8}$/.test(nome)) {
    throw new Error("Recusado: só se remove banco criado por criarBancoDeExecucao");
  }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${nome}" with (force)`);
  } finally {
    await admin.end();
  }
}

// Ponto de entrada do globalSetup do Vitest (projeto de integração).
export async function setup(projeto: {
  provide: (chave: "urlBancoExecucao" | "alvoBanco", valor: string) => void;
}) {
  const alvo = process.env.ALVO_BANCO === "neon" ? "neon" : "local";
  projeto.provide("alvoBanco", alvo);
  if (alvo === "neon") {
    projeto.provide("urlBancoExecucao", "");
    return;
  }
  const banco = await criarBancoDeExecucao();
  nomeCriado = banco.nome;
  projeto.provide("urlBancoExecucao", banco.url);
}

let nomeCriado: string | undefined;

export async function teardown() {
  if (nomeCriado) await removerBancoDeExecucao(nomeCriado);
}

declare module "vitest" {
  export interface ProvidedContext {
    urlBancoExecucao: string;
    alvoBanco: "local" | "neon";
  }
}
