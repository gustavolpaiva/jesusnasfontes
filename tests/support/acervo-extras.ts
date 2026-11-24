import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { carregarFontes } from "../../scripts/acervo/carregar";
import { urlDoPapel } from "../../src/db/url";
import { interpretarDerivado, interpretarFonteYaml } from "../../src/modules/acervo/schemas";
import { escrever } from "./login-e2e";

// Fontes de TESTE para os estados raros da página da Fonte (aviso de tradução, obra de uma só seção, Fonte sem
// limites). Entram SOB DEMANDA no banco do e2e, pela mesma `carregarFontes` do `acervo:load`, e saem no fim do
// arquivo de teste: nunca no semeador global, e nunca no banco real. O texto é o do derivado da fixture do
// Josefo, com slug próprio. O sufixo do slug separa os dois projetos (celular e computador), que rodam o mesmo
// arquivo ao mesmo tempo contra o mesmo banco: um não apaga a Fonte do outro.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "acervo",
);

export const EXTRAS = [
  "fonte-traduzida-teste",
  "fonte-uma-secao-teste",
  "fonte-sem-limites-teste",
] as const;
export type Extra = (typeof EXTRAS)[number];

export type SlugsExtras = Record<Extra, string>;

export const slugsDosExtras = (sufixo: string): SlugsExtras => ({
  "fonte-traduzida-teste": `fonte-traduzida-teste-${sufixo}`,
  "fonte-uma-secao-teste": `fonte-uma-secao-teste-${sufixo}`,
  "fonte-sem-limites-teste": `fonte-sem-limites-teste-${sufixo}`,
});

export async function semearExtras(sufixo: string): Promise<SlugsExtras> {
  const slugs = slugsDosExtras(sufixo);
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  const itens = EXTRAS.map((nome) => {
    const slug = slugs[nome];
    const yaml = readFileSync(path.join(FIXTURES, "fontes-extras", `${nome}.yaml`), "utf8").replace(
      /^slug: .*$/m,
      `slug: ${slug}`,
    );
    const fonte = interpretarFonteYaml(yaml, `${nome}.yaml`);
    const nasSecoes = new Set(fonte.secoes.map((s) => s.slug));
    const derivado = interpretarDerivado(
      {
        ...bruto,
        slug,
        secoes: bruto.secoes.filter(
          (s: { slug: string }) => nasSecoes.size === 0 || nasSecoes.has(s.slug),
        ),
      },
      `${nome}.json`,
    );
    return { fonte, derivado };
  });
  const cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, process.env),
  });
  await cliente.connect();
  try {
    await carregarFontes(itens, { cliente });
  } finally {
    await cliente.end().catch(() => {});
  }
  return slugs;
}

/** Tira as Fontes de teste do banco do e2e (como dono: a carga recusa apagar Fonte inteira). */
export async function removerExtras(sufixo: string): Promise<void> {
  for (const slug of Object.values(slugsDosExtras(sufixo))) {
    await escrever(
      "delete from acervo.fonte_paragrafo where secao_id in (select id from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1))",
      [slug],
    );
    await escrever(
      "delete from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1)",
      [slug],
    );
    await escrever("delete from acervo.fonte where slug = $1", [slug]);
  }
}
