// Busca de arquivos de terceiros no commit fixado, com sha256 conferido ANTES de devolver qualquer conteúdo.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const COMMIT_BIBLIA_LIVRE = "a315a15e9f4d01883b62206fe441d57762f126b3";
export const URL_BASE_BIBLIA_LIVRE = `https://raw.githubusercontent.com/blivre/BibliaLivre/${COMMIT_BIBLIA_LIVRE}/textos/f4`;
export const EDICOES = ["n4", "tr"] as const;
export type Edicao = (typeof EDICOES)[number];

export class ErroChecksum extends Error {
  readonly esperado: string;
  readonly obtido: string;
  readonly origem: string;
  constructor(origem: string, esperado: string, obtido: string) {
    super(`sha256 diferente em ${origem}: esperado ${esperado}, obtido ${obtido}`);
    this.name = "ErroChecksum";
    this.origem = origem;
    this.esperado = esperado;
    this.obtido = obtido;
  }
}

export function urlArquivo(edicao: Edicao, arquivo: string): string {
  return `${URL_BASE_BIBLIA_LIVRE}/${edicao}/${arquivo}`;
}

export function sha256(conteudo: Uint8Array): string {
  return createHash("sha256").update(conteudo).digest("hex");
}

export type Obter = (url: string) => Promise<Uint8Array>;

const obterPorRede: Obter = async (url) => {
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error(`falha ao baixar ${url}: HTTP ${resposta.status}`);
  return new Uint8Array(await resposta.arrayBuffer());
};

async function lerSeExiste(destino: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(destino));
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw erro;
  }
}

/**
 * Devolve o conteúdo e o sha256. Com `sha256Esperado`, o cache em `destino` só vale se tiver o mesmo
 * sha256, e o que veio da rede diferente lança ErroChecksum sem gravar nada em disco.
 */
export async function buscarArquivo(
  url: string,
  destino: string,
  sha256Esperado?: string,
  obter: Obter = obterPorRede,
): Promise<{ conteudo: Uint8Array; sha256: string }> {
  const emCache = await lerSeExiste(destino);
  if (emCache && sha256Esperado && sha256(emCache) === sha256Esperado) {
    return { conteudo: emCache, sha256: sha256Esperado };
  }
  const conteudo = await obter(url);
  const obtido = sha256(conteudo);
  if (sha256Esperado && obtido !== sha256Esperado)
    throw new ErroChecksum(url, sha256Esperado, obtido);
  await mkdir(path.dirname(destino), { recursive: true });
  await writeFile(destino, conteudo);
  return { conteudo, sha256: obtido };
}

export type CorrecaoRegistro = {
  edicao: Edicao;
  arquivo: string;
  linha: number;
  de: string;
  para: string[];
  motivo: string;
};

export type Registro = {
  commit: string;
  edicoes: Edicao[];
  correcoes_marcacao: CorrecaoRegistro[];
  esperado?: Esperado;
  [campo: string]: unknown;
};

export type Esperado = {
  versiculos: number;
  capitulos: number;
  excecoes: { tipo: string; referencia: string; dentro_de: string }[];
  evangelhos: { capitulos: number; versiculos: number };
  sem_texto?: { referencia: string; edicao: Edicao; motivo: string }[];
};

export type Lock = { commit: string; arquivos: Record<string, string> };

export const RAIZ_PRODUTO = fileURLToPath(new URL("../../", import.meta.url));
export const CAMINHO_REGISTRO = path.join(RAIZ_PRODUTO, "data/datasets.yaml");
export const CAMINHO_LOCK = path.join(RAIZ_PRODUTO, "data/datasets.lock.json");
export const DIR_RAW = path.join(RAIZ_PRODUTO, "data/raw/biblia-livre");

export async function lerRegistro(): Promise<Registro> {
  const doc = parse(await readFile(CAMINHO_REGISTRO, "utf8")) as Record<string, Registro>;
  const r = doc["biblia-livre"];
  if (!r) throw new Error("datasets.yaml sem a entrada biblia-livre");
  if (r.commit !== COMMIT_BIBLIA_LIVRE) {
    throw new Error(
      `commit do registro (${r.commit}) difere do fixado no código (${COMMIT_BIBLIA_LIVRE})`,
    );
  }
  return r;
}

export async function lerLock(): Promise<Lock> {
  const lock = JSON.parse(await readFile(CAMINHO_LOCK, "utf8")) as Lock;
  if (lock.commit !== COMMIT_BIBLIA_LIVRE) throw new Error("datasets.lock.json é de outro commit");
  return lock;
}
