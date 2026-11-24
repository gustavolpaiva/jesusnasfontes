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

// As Fontes apócrifas REAIS dos evangelhos e escritos não canônicos (ANF 8 e ANF 9, plano 02-12) — YAML e
// derivado do repositório — num banco descartável: as seções, todos os parágrafos e a segunda carga sem
// mudar nada. Cria Fontes, então não roda no Neon (lá a carga real é conferida por contagem, sem teste de
// integração).

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

const SLUGS = [
  "protoevangelho-de-tiago",
  "evangelho-de-pseudo-mateus",
  "evangelho-da-infancia-de-tome",
  "evangelho-arabe-da-infancia",
  "atos-de-pilatos",
  "cartas-e-relatorio-de-pilatos",
  "historia-de-jose-o-carpinteiro",
  "evangelho-de-pedro",
  "apocalipse-de-pedro",
  "atos-de-paulo-e-tecla",
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

describe.skipIf(emNeon())("carga das dez Fontes apócrifas reais (ANF 8 e ANF 9)", () => {
  it("carrega as seções e todos os parágrafos; segunda carga sem mudança", async () => {
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
    expect(totalSecoes).toBe(17);
    expect(totalParagrafos).toBe(672);

    const r = await carregarFontes(itens, { cliente: carga });
    expect(r.fontes.inseridos).toBe(10);
    expect(r.secoes.inseridos).toBe(totalSecoes);
    expect(r.paragrafos.inseridos).toBe(totalParagrafos);

    // As âncoras distintivas chegam ao banco: a anunciação do Protoevangelio e a assinatura de Tiago, os
    // doze pardais da Infância de Tomé e o seu fecho latino, o menino que fala no berço (Árabe), os
    // estandartes diante de Jesus e o "inclina-te, ó cruz" (Atos de Pilatos), a carta a Tibério, a
    // descrição física de Paulo, o corpo pedido a Pilatos (Evangelho de Pedro) e os justos mais brancos
    // que a neve (Apocalipse).
    const refs = await dono.query<{ ref: string; texto: string }>(
      `select p.ref, p.texto from acervo.fonte_paragrafo p where p.ref = any($1)`,
      [
        [
          "vii.iv-p45",
          "vii.iv-p88",
          "vii.viii-p6",
          "vii.x.xv-p5",
          "vii.xi-p5",
          "vii.xii.ii-p13",
          "vii.xiii.xi-p10",
          "vii.xviii-p3",
          "vii.xxvi-p6",
          "iii.ii-p6",
          "v.ii-p10",
        ],
      ],
    );
    const porRef = new Map(refs.rows.map((x) => [x.ref, x.texto]));
    expect(porRef.get("vii.iv-p45")).toContain("Hail, thou who hast received grace");
    expect(porRef.get("vii.iv-p88")).toContain("I James that wrote this history");
    expect(porRef.get("vii.viii-p6")).toContain("twelve sparrows");
    expect(porRef.get("vii.x.xv-p5")).toContain("I Thomas the Israelite have written");
    expect(porRef.get("vii.xi-p5")).toContain("I am Jesus, the Son of God, the Logos");
    expect(porRef.get("vii.xii.ii-p13")).toContain("adored Jesus");
    expect(porRef.get("vii.xiii.xi-p10")).toContain("Bend down, O cross");
    expect(porRef.get("vii.xviii-p3")).toContain("Pontius Pilate to Tiberius");
    expect(porRef.get("vii.xxvi-p6")).toContain("small in size, bald-headed");
    expect(porRef.get("iii.ii-p6")).toContain("asked the body of the Lord for burial");
    expect(porRef.get("v.ii-p10")).toContain("whiter than any snow");

    // A Infância de Tomé sai nas três formas do volume, na ordem dele (nunca como os 114 ditos).
    const formas = await dono.query<{ slug: string; ordem: number }>(
      `select s.slug, s.ordem from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id
         where f.slug = 'evangelho-da-infancia-de-tome' order by s.ordem`,
    );
    expect(formas.rows.map((x) => x.slug)).toEqual(["vii-viii", "vii-ix", "vii-x"]);

    const segunda = await carregarFontes(itens, { cliente: carga });
    expect(segunda.inseridos).toBe(0);
    expect(segunda.atualizados).toBe(0);
    expect(segunda.removidos).toBe(0);
  }, 240_000);
});
