import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { slugsDasFontesPublicadas } from "@/modules/acervo/consultas";
import { interpretarDerivado, interpretarFonteYaml } from "@/modules/acervo/schemas";
import { montarCreditos } from "@/modules/creditos/creditos";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Despublicar uma Fonte no painel não passa pelo YAML: o link de "Usado em" da página de créditos tem de sair junto,
// senão leva a uma página 404 (plano 02-22, revisão cruzada, MÉDIA). A leitura é do papel do aplicativo, pela política
// de linha (só Fonte publicada), num instantâneo só. Banco descartável SÓ deste arquivo; não roda no Neon.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;

const ALVO = "josefo-antiguidades";
const linksDoAlvo = (publicadas: ReadonlySet<string>) =>
  montarCreditos({ publicadasNoBanco: publicadas })
    .filter((e) => e.grupo === "acervo")
    .flatMap((e) => e.usadoEm.map((f) => f.slug))
    .filter((slug) => slug === ALVO);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
  const fonte = interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", `${ALVO}.yaml`), "utf8"),
    `${ALVO}.yaml`,
  );
  const derivado = interpretarDerivado(
    JSON.parse(readFileSync(path.join(FIXTURES, "derivados", `${ALVO}.json`), "utf8")),
    `${ALVO}.json`,
  );
  await carregarFontes([{ fonte, derivado }], { cliente: carga });
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())(
  "créditos: o link de 'Usado em' segue o que o banco diz publicado",
  () => {
    it("Fonte publicada no banco: o slug é lido pelo papel do aplicativo e o link aparece", async () => {
      const publicadas = await slugsDasFontesPublicadas();
      expect(publicadas.has(ALVO)).toBe(true);
      expect(linksDoAlvo(publicadas)).toEqual([ALVO]);
    });

    it("o painel despublica a Fonte: o slug some da leitura e o link some da página (sem build nenhum)", async () => {
      await dono.query("update acervo.fonte set publicada = false where slug = $1", [ALVO]);
      const publicadas = await slugsDasFontesPublicadas();
      expect(publicadas.has(ALVO)).toBe(false);
      expect(linksDoAlvo(publicadas)).toEqual([]);
    });

    it("publica de novo: o link volta", async () => {
      await dono.query("update acervo.fonte set publicada = true where slug = $1", [ALVO]);
      const publicadas = await slugsDasFontesPublicadas();
      expect(linksDoAlvo(publicadas)).toEqual([ALVO]);
    });

    it("Fonte de ficha publicada nunca entra no conjunto (só texto integral)", async () => {
      const todas = await slugsDasFontesPublicadas();
      const fichas = (
        await dono.query<{ slug: string }>(
          "select slug from acervo.fonte where tipo_texto = 'ficha'",
        )
      ).rows.map((r) => r.slug);
      for (const slug of fichas) expect(todas.has(slug)).toBe(false);
    });
  },
);
