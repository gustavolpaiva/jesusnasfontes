import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { interpretarFonteYaml } from "@/modules/acervo/schemas";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import {
  CAMINHO_LOCK,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "../../../scripts/acervo/derivados";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// As nove Fontes REAIS dos Pais Apostólicos (coleção de Lightfoot no CCEL, plano 02-10) — YAML e derivado do
// repositório — num banco descartável: as quinze seções (sete cartas de Inácio), todos os parágrafos e a
// segunda carga sem mudar nada. Cria Fontes, então não roda no Neon (lá a carga real é conferida por
// contagem, sem teste de integração).

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

const SLUGS = [
  "1-clemente",
  "2-clemente",
  "inacio-cartas",
  "policarpo-filipenses",
  "martirio-de-policarpo",
  "didaque",
  "barnabe",
  "hermas",
  "diogneto",
] as const;

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("carga das nove Fontes reais de Lightfoot", () => {
  it("carrega as quinze seções e todos os parágrafos; segunda carga sem mudança", async () => {
    const lock = lerLock(CAMINHO_LOCK);
    verificarDerivados(PASTA_DERIVADOS, lock);
    const itens = SLUGS.map((slug) => ({
      fonte: interpretarFonteYaml(
        readFileSync(path.join(RAIZ, "content", "acervo", "fontes", `${slug}.yaml`), "utf8"),
        `${slug}.yaml`,
      ),
      derivado: lerDerivado(PASTA_DERIVADOS, lock, slug),
    }));
    const totalSecoes = itens.reduce((n, i) => n + i.derivado.secoes.length, 0);
    const totalParagrafos = itens.reduce(
      (n, i) => n + i.derivado.secoes.reduce((m, s) => m + s.paragrafos.length, 0),
      0,
    );
    expect(totalSecoes).toBe(15);
    expect(totalParagrafos).toBe(1933);

    const r = await carregarFontes(itens, { cliente: carga });
    expect(r.fontes.inseridos).toBe(9);
    expect(r.secoes.inseridos).toBe(15);
    expect(r.paragrafos.inseridos).toBe(totalParagrafos);

    // A abertura da Didaqué (duas vias) e a carta de Inácio aos Romanos no meio das sete.
    const p = await dono.query<{ ref: string; texto: string }>(
      `select p.ref, p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'didaque' and p.ref = 'ii.xii-p1'`,
    );
    expect(p.rows[0]?.texto).toContain("There are two ways");
    // A Oração do Senhor e as orações eucarísticas são <verse> irmão de <p> na origem: chegam ao banco.
    const versos = await dono.query<{ ref: string; texto: string }>(
      `select p.ref, p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'didaque' and p.ref in ('ii.xii-p48.3', 'ii.xii-p51.3', 'ii.xii-p54.21')`,
    );
    const porRef = new Map(versos.rows.map((x) => [x.ref, x.texto]));
    expect(porRef.get("ii.xii-p48.3")).toContain(
      "Our Father, which art in heaven, / hallowed be Thy name;",
    );
    expect(porRef.get("ii.xii-p51.3")).toContain("for the holy vine of Thy son David");
    expect(porRef.get("ii.xii-p54.21")).toContain("Remember, Lord, Thy Church");
    const ordem = await dono.query<{ slug: string; ordem: number }>(
      `select s.slug, s.ordem from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'inacio-cartas' order by s.ordem`,
    );
    expect(ordem.rows.map((x) => x.slug)).toEqual([
      "ii-iii",
      "ii-iv",
      "ii-v",
      "ii-vi",
      "ii-vii",
      "ii-viii",
      "ii-ix",
    ]);

    const segunda = await carregarFontes(itens, { cliente: carga });
    expect(segunda.inseridos).toBe(0);
    expect(segunda.atualizados).toBe(0);
    expect(segunda.removidos).toBe(0);
  }, 120_000);
});
