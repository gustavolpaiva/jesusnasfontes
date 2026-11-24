// `pnpm acervo:extrato <slug>` — resumo estrutural por seção para o redator do resumo auxiliar (D-18): o que a
// seção é, quão grande e como ela começa. SÓ LEITURA: lê o YAML (quando existe) e o derivado versionado com o
// lock; nunca o bruto, nunca rede, nunca grava nada.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Derivado,
  type FonteYaml,
  interpretarFonteYaml,
} from "../../src/modules/acervo/schemas";
import { PASTA_FONTES } from "./carregar";
import { lerDerivado, lerLock, PASTA_DERIVADOS } from "./derivados";

export type ExtratoDeSecao = {
  numero: number;
  slug: string;
  titulo: string;
  paragrafos: number;
  caracteres: number;
  abertura: string;
};

export const LIMITE_ABERTURA = 500;

/**
 * O extrato de cada seção do derivado: ordem, título (o do YAML quando existe), contagem de parágrafos, total
 * de caracteres de texto e a abertura (o comecinho do primeiro parágrafo, limitado a `limite`).
 */
export function extratoDaFonte(
  derivado: Derivado,
  titulosDoYaml?: ReadonlyMap<string, string>,
  limite: number = LIMITE_ABERTURA,
): ExtratoDeSecao[] {
  return derivado.secoes.map((s, i) => ({
    numero: i + 1,
    slug: s.slug,
    titulo: titulosDoYaml?.get(s.slug) ?? s.titulo,
    paragrafos: s.paragrafos.length,
    caracteres: s.paragrafos.reduce((n, p) => n + p.texto.length, 0),
    abertura: (s.paragrafos[0]?.texto ?? "").replace(/\s+/g, " ").trim().slice(0, limite),
  }));
}

function principal(): void {
  const slug = process.argv[2];
  if (!slug || slug.startsWith("--")) {
    console.error("uso: pnpm acervo:extrato <slug>");
    process.exit(2);
  }
  const lock = lerLock();
  const derivado = lerDerivado(PASTA_DERIVADOS, lock, slug);
  const caminhoYaml = path.join(PASTA_FONTES, `${slug}.yaml`);
  let titulos: ReadonlyMap<string, string> | undefined;
  if (existsSync(caminhoYaml)) {
    const fonte: FonteYaml = interpretarFonteYaml(
      readFileSync(caminhoYaml, "utf8"),
      `${slug}.yaml`,
    );
    titulos = new Map(fonte.secoes.map((s) => [s.slug, s.titulo]));
  } else {
    console.log(`(sem YAML de ${slug}; os títulos são os do derivado)`);
  }
  const numero = (v: number) => v.toLocaleString("pt-BR");
  for (const e of extratoDaFonte(derivado, titulos)) {
    console.log(
      `${e.numero}. ${e.titulo} (slug ${e.slug}) — ${e.paragrafos} parágrafos, ${numero(e.caracteres)} caracteres`,
    );
    console.log(`   abertura: ${e.abertura}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    principal();
  } catch (erro) {
    console.error((erro as Error).message);
    process.exit(1);
  }
}
