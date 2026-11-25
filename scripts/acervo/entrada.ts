// A ENTRADA de uma carga é tudo o que o carregador lê para gravar uma Fonte: o derivado (o texto) e o YAML da Fonte
// (título, licença, origem, seções, resumos…). O lock `data/acervo-derivados.lock.json` versiona a entrada inteira: o
// sha256 do derivado, o sha256 do YAML normalizado e uma `revisao` monótona que sobe quando QUALQUER um dos dois muda.
// O banco guarda a revisão e o sha256 da entrada de que cada Fonte veio; uma entrada mais velha nunca a sobrescreve.
// Só `node:crypto` e o contrato: nenhum módulo de rede ou de banco.

import { createHash } from "node:crypto";
import type { FonteYaml } from "../../src/modules/acervo/schemas";

/** O valor que ainda não foi travado: um YAML novo no lock, antes de `pnpm acervo:travar`. Nunca casa com um YAML. */
export const YAML_NAO_TRAVADO = "0".repeat(64);

const sha256 = (texto: string) => createHash("sha256").update(texto).digest("hex");

/** JSON de chaves em ordem alfabética, em qualquer profundidade: o mesmo objeto, os mesmos bytes. */
function normalizar(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(normalizar).join(",")}]`;
  const o = valor as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${normalizar(o[k])}`)
    .join(",")}}`;
}

/** O sha256 do YAML da Fonte já validado pelo contrato (comentário e ordem de chaves do arquivo não contam). */
export function hashDoYaml(fonte: FonteYaml): string {
  return sha256(normalizar(fonte));
}

/** O sha256 da entrada inteira, o que o banco guarda: o do derivado e o do YAML, juntos. */
export function shaDaEntrada(shaDoDerivado: string, shaDoYaml: string): string {
  return sha256(`derivado:${shaDoDerivado}\nyaml:${shaDoYaml}`);
}
