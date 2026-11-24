import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { carregarFontes, type ResultadoFontes } from "../../scripts/acervo/carregar";
import { urlDoPapel } from "../../src/db/url";
import {
  type FonteYaml,
  interpretarDerivado,
  interpretarFonteYaml,
} from "../../src/modules/acervo/schemas";
import { escrever } from "./login-e2e";

// Fontes de TESTE para o painel de Fontes (plano 02-17). A Fonte do arquivo é a do recorte do Josefo das fixtures com
// OUTRO slug e NÃO publicada: o Josefo de verdade do banco do e2e é lido por outras telas e não pode ser editado aqui.
// A carga é a de verdade (`carregarFontes`), então a marca da última carga e o conflito são os reais. Saem no fim do
// arquivo, pelo dono do banco.

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "acervo");

function itemDaFixture(
  slug: string,
  publicada: boolean,
  mudar: (f: FonteYaml) => FonteYaml = (f) => f,
) {
  const fonte = interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
    "josefo-antiguidades.yaml",
  );
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  bruto.slug = slug;
  return {
    fonte: mudar({ ...fonte, slug, titulo: `Fonte do arquivo ${slug}`, publicada }),
    derivado: interpretarDerivado(bruto, `${slug}.json`),
  };
}

async function comCarga<T>(fn: (cliente: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end().catch(() => {});
  }
}

/** Carrega a Fonte do arquivo de teste (a mesma chamada serve para a "nova carga" que provoca o conflito). */
export function cargarFonteDoArquivo(
  slug: string,
  publicada = false,
  mudar?: (f: FonteYaml) => FonteYaml,
): Promise<ResultadoFontes> {
  return comCarga((cliente) =>
    carregarFontes([itemDaFixture(slug, publicada, mudar)], { cliente }),
  );
}

export const LIMITES_DO_ARQUIVO = interpretarFonteYaml(
  readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
  "josefo-antiguidades.yaml",
).limites_pt as string;

/** Tira a Fonte de teste (e o que depende dela) do banco do e2e, como dono. O registro interno guarda só o slug. */
export async function removerFonteDeTeste(slug: string): Promise<void> {
  await escrever(
    "delete from acervo.fonte_paragrafo where secao_id in (select s.id from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id where f.slug = $1)",
    [slug],
  );
  await escrever(
    "delete from acervo.fonte_secao where fonte_id = (select id from acervo.fonte where slug = $1)",
    [slug],
  );
  await escrever("delete from acervo.fonte where slug = $1", [slug]);
}
