// Conferência dos derivados do Acervo (o texto já interpretado de cada Fonte, versionado em
// `data/acervo-derivados/<slug>.json`) contra o lock `data/acervo-derivados.lock.json`: sha256, tamanho em bytes
// e orçamento por arquivo e total. SÓ `node:fs`, `node:crypto` e o contrato zod: nenhum módulo de rede, nenhum
// de banco. A carga chama isto ANTES de abrir qualquer conexão. Mensagem de erro nomeia a Fonte e traz números,
// nunca texto da Fonte.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Derivado, interpretarDerivado } from "../../src/modules/acervo/schemas";

export class ErroDerivado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroDerivado";
  }
}

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CAMINHO_LOCK = path.join(RAIZ, "data", "acervo-derivados.lock.json");
export const PASTA_DERIVADOS = path.join(RAIZ, "data", "acervo-derivados");

const esquemaLock = z
  .object({
    orcamento_arquivo_bytes: z.number().int().min(1),
    orcamento_total_bytes: z.number().int().min(1),
    derivados: z.record(
      z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
      z
        .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0) })
        .strict(),
    ),
  })
  .strict();
export type LockDerivados = z.infer<typeof esquemaLock>;

export type DerivadoConferido = { slug: string; caminho: string; bytes: number; sha256: string };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function lerLock(caminho: string = CAMINHO_LOCK): LockDerivados {
  let bruto: unknown;
  try {
    bruto = JSON.parse(readFileSync(caminho, "utf8"));
  } catch {
    throw new ErroDerivado(`lock dos derivados ausente ou ilegível: ${path.basename(caminho)}`);
  }
  const r = esquemaLock.safeParse(bruto);
  if (!r.success) {
    const campos = [
      ...new Set(r.error.issues.map((i) => i.path.map(String).join(".") || "(raiz)")),
    ];
    throw new ErroDerivado(`lock dos derivados fora do formato: ${campos.join(", ")}`);
  }
  return r.data;
}

function listarJson(pasta: string): string[] {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith(".json"))
    .sort();
}

/**
 * Todo `.json` da pasta tem de estar no lock, e toda entrada do lock tem de ter o arquivo, com os mesmos
 * bytes e o mesmo sha256; nenhum derivado passa de `orcamento_arquivo_bytes` e a soma não passa de
 * `orcamento_total_bytes` (o limite é inclusivo). Não interpreta o conteúdo como contrato.
 */
export function verificarDerivados(pasta: string, lock: LockDerivados): DerivadoConferido[] {
  const arquivos = listarJson(pasta);
  const slugsEmDisco = new Set(arquivos.map((a) => a.slice(0, -".json".length)));

  for (const slug of slugsEmDisco) {
    if (!lock.derivados[slug]) throw new ErroDerivado(`derivado ${slug}: fora do lock`);
  }
  for (const slug of Object.keys(lock.derivados).sort()) {
    if (!slugsEmDisco.has(slug))
      throw new ErroDerivado(`derivado ${slug}: está no lock, mas o arquivo não existe`);
  }

  // Tamanhos e orçamento primeiro (barato, sem ler o conteúdo); o sha256 depois.
  const medidos = [...slugsEmDisco].sort().map((slug) => {
    const caminho = path.join(pasta, `${slug}.json`);
    return { slug, caminho, bytes: statSync(caminho).size };
  });
  let soma = 0;
  for (const m of medidos) {
    const noLock = (lock.derivados[m.slug] as { bytes: number }).bytes;
    if (m.bytes !== noLock)
      throw new ErroDerivado(
        `derivado ${m.slug}: tamanho diferente do lock (lock ${noLock} bytes, medido ${m.bytes} bytes)`,
      );
    if (m.bytes > lock.orcamento_arquivo_bytes)
      throw new ErroDerivado(
        `derivado ${m.slug}: acima de orcamento_arquivo_bytes (limite ${lock.orcamento_arquivo_bytes}, medido ${m.bytes})`,
      );
    soma += m.bytes;
  }
  if (soma > lock.orcamento_total_bytes)
    throw new ErroDerivado(
      `derivados: soma acima de orcamento_total_bytes (limite ${lock.orcamento_total_bytes}, medido ${soma})`,
    );

  return medidos.map((m) => {
    const esperado = (lock.derivados[m.slug] as { sha256: string }).sha256;
    const obtido = sha256(readFileSync(m.caminho));
    if (obtido !== esperado)
      throw new ErroDerivado(
        `derivado ${m.slug}: sha256 diferente do lock (lock ${esperado}, medido ${obtido})`,
      );
    return { ...m, sha256: obtido };
  });
}

/**
 * Lê UM derivado e o interpreta pelo contrato. Os bytes lidos aqui são conferidos de novo contra o lock antes de
 * qualquer interpretação: um arquivo trocado depois de `verificarDerivados` não passa.
 */
export function lerDerivado(pasta: string, lock: LockDerivados, slug: string): Derivado {
  const entrada = lock.derivados[slug];
  if (!entrada) throw new ErroDerivado(`derivado ${slug}: fora do lock`);
  const arquivo = `${slug}.json`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(pasta, arquivo));
  } catch {
    throw new ErroDerivado(`derivado ${slug}: o arquivo não existe`);
  }
  if (bytes.length !== entrada.bytes || sha256(bytes) !== entrada.sha256)
    throw new ErroDerivado(
      `derivado ${slug}: o arquivo mudou depois da conferência (sha256 ou tamanho)`,
    );
  let bruto: unknown;
  try {
    bruto = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ErroDerivado(`derivado ${slug}: JSON ilegível`);
  }
  return interpretarDerivado(bruto, arquivo);
}
