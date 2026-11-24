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

// As doze Fontes REAIS dos Padres e do testemunho antigo (ANF 1/3/4/6/8/9 e NPNF 2-1, plano 02-11) — YAML e
// derivado do repositório — num banco descartável: as 34 seções, todos os parágrafos e a segunda carga sem
// mudar nada. Cria Fontes, então não roda no Neon (lá a carga real é conferida por contagem, sem teste de
// integração).

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

const SLUGS = [
  "mara-bar-serapiao",
  "papias-fragmentos",
  "aristides-apologia",
  "justino-1-apologia",
  "justino-2-apologia",
  "justino-dialogo-trifao",
  "tertuliano-apologetico",
  "taciano-diatessaron",
  "ireneu-contra-heresias",
  "eusebio-historia-eclesiastica",
  "julio-africano-fragmentos",
  "origenes-contra-celso",
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

describe.skipIf(emNeon())("carga das doze Fontes reais dos Padres (ANF/NPNF)", () => {
  it("carrega as trinta e quatro seções e todos os parágrafos; segunda carga sem mudança", async () => {
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
    expect(totalSecoes).toBe(34);
    expect(totalParagrafos).toBe(5855);

    const r = await carregarFontes(itens, { cliente: carga });
    expect(r.fontes.inseridos).toBe(12);
    expect(r.secoes.inseridos).toBe(34);
    expect(r.paragrafos.inseridos).toBe(totalParagrafos);

    // As âncoras citadas pelas Afirmações chegam ao banco: a carta de Mara (tracer do plano 02-08), o
    // prefácio de Papias e a tradição de Marcos/Mateus, a divisão 3.1 de Ireneu, Eusébio 3.39 (Papias) e
    // 1.11 (Josefo), e o fragmento de Thalo em Júlio Africano.
    const refs = await dono.query<{ ref: string; texto: string }>(
      `select p.ref, p.texto from acervo.fonte_paragrafo p where p.ref = any($1)`,
      [
        [
          "ix.xvii-p5",
          "vii.ii.i-p4",
          "vii.ii.vi-p2",
          "ix.iv.ii-p1",
          "iii.viii.xxxix-p2",
          "iii.vi.xi-p18",
          "v.v.xviii-p4",
        ],
      ],
    );
    const porRef = new Map(refs.rows.map((x) => [x.ref, x.texto]));
    expect(porRef.get("ix.xvii-p5")).toContain("Mara");
    expect(porRef.get("vii.ii.i-p4")).toContain("what Andrew or Peter said");
    expect(porRef.get("vii.ii.vi-p2")).toContain("Mark having become the interpreter of Peter");
    expect(porRef.get("ix.iv.ii-p1")).toContain("the ground and pillar of our faith");
    expect(porRef.get("iii.viii.xxxix-p2")).toContain("five books of Papias");
    expect(porRef.get("iii.vi.xi-p18")).toContain("he was a doer of wonderful works");
    expect(porRef.get("v.v.xviii-p4")).toContain("an eclipse of the sun");
    // Contra Celso sai em oito livros (div3 vi.ix.i–viii), na ordem do volume.
    const livros = await dono.query<{ slug: string; ordem: number }>(
      `select s.slug, s.ordem from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id
         where f.slug = 'origenes-contra-celso' order by s.ordem`,
    );
    expect(livros.rows.map((x) => x.slug)).toEqual([
      "vi-ix-i",
      "vi-ix-ii",
      "vi-ix-iii",
      "vi-ix-iv",
      "vi-ix-v",
      "vi-ix-vi",
      "vi-ix-vii",
      "vi-ix-viii",
    ]);

    const segunda = await carregarFontes(itens, { cliente: carga });
    expect(segunda.inseridos).toBe(0);
    expect(segunda.atualizados).toBe(0);
    expect(segunda.removidos).toBe(0);
  }, 240_000);
});
