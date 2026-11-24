import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { interpretarFonteYaml } from "@/modules/acervo/schemas";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import { derivar } from "../../../scripts/ingest/acervo-derivar";
import type { OrigemAcervo } from "../../../scripts/ingest/acervo-origens";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Tracer da família ThML (CCEL): o recorte REAL da carta de Mara bar Serapião (ANF 8) é derivado em memória
// pela MESMA função que o `acervo:derivar` usa (licença DC.Rights lida no cabeçalho, parser sem as notas de
// editor, id estável ix.xvii da própria edição) e carregado com o YAML de fixture; a segunda carga não muda
// nada. Cria Fontes, então usa banco descartável local e não roda no Neon.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const emNeon = () => inject("alvoBanco") === "neon";

const bruto = new Uint8Array(readFileSync(path.join(FIXTURES, "ccel-anf08-mara.xml")));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const ORIGEM: OrigemAcervo = {
  nome: "CCEL (fixture)",
  autores: ["Christian Classics Ethereal Library"],
  licenca: "Domínio público, como declara a origem (DC.Rights)",
  url_licenca: "https://ccel.org/ccel/schaff/anf08.xml",
  fonte: "https://ccel.org/ccel/schaff/anf08",
  commit: sha256(bruto),
  data_versao: "2026-11-24",
  alteracoes: "Notas de editor removidas do texto; numeração da edição mantida.",
  formato: "thml",
  publicavel: true,
  motivo: "DC.Rights 'Public Domain' lido no próprio arquivo",
  arquivos: [
    {
      id: "anf08.xml",
      url: "https://ccel.org/ccel/schaff/anf08.xml",
      slug: "mara-bar-serapiao",
      idioma: "en",
      divisao_secao: "div2",
    },
  ],
  verificador: { editores: ["Schaff, Philip (1819-1893)"], licenca: "Public Domain" },
  esperado: {
    secoes: 1,
    paragrafos: [
      {
        ref: "ix.xvii-p5",
        contem: ["Mara", "Serapion"],
        nao_contem: ["Dr. Payne Smith"],
      },
    ],
    notas_fora_do_texto: true,
  },
};

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

describe.skipIf(emNeon())("carga ThML: Mara bar Serapião do bruto ao banco", () => {
  it("deriva o recorte real e carrega; a segunda carga devolve inseridos=0 e atualizados=0", async () => {
    const derivado = derivar({
      origemId: "ccel-anf08",
      origem: ORIGEM,
      arquivo: ORIGEM.arquivos[0] as OrigemAcervo["arquivos"][number],
      bruto,
      sha256Lock: sha256(bruto),
    });
    expect(derivado.secoes).toHaveLength(1);
    expect(derivado.secoes[0]?.slug).toBe("ix-xvii");
    expect(derivado.secoes[0]?.paragrafos.length).toBe(33);
    const fonte = interpretarFonteYaml(
      readFileSync(path.join(FIXTURES, "fontes", "mara-bar-serapiao.yaml"), "utf8"),
      "mara-bar-serapiao.yaml",
    );

    const r = await carregarFontes([{ fonte, derivado }], { cliente: carga });
    expect(r.fontes.inseridos).toBe(1);
    expect(r.secoes.inseridos).toBe(1);
    expect(r.paragrafos.inseridos).toBe(33);

    const p = (
      await dono.query<{ id: string; texto: string }>(
        "select id, texto from acervo.fonte_paragrafo where id = 'mara-bar-serapiao/ix.xvii-p5'",
      )
    ).rows[0];
    expect(p?.texto).toBe("Mara, son of Serapion, to Serapion, my son: peace.");

    const todos = await dono.query<{ texto: string }>(
      `select p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'mara-bar-serapiao'`,
    );
    expect(todos.rows).toHaveLength(33);
    for (const { texto } of todos.rows) {
      expect(texto).not.toContain("Payne Smith");
      expect(texto).not.toContain("<note");
    }

    const segunda = await carregarFontes([{ fonte, derivado }], { cliente: carga });
    expect(segunda.inseridos).toBe(0);
    expect(segunda.atualizados).toBe(0);
    expect(segunda.removidos).toBe(0);
  }, 120_000);

  it("trocar o conteúdo do arquivo e perder o id citado faz a verificação falhar", () => {
    const adulterado = new TextEncoder().encode(
      new TextDecoder().decode(bruto).replace('id="ix.xvii-p5"', 'id="ix.xvii-p999"'),
    );
    expect(() =>
      derivar({
        origemId: "ccel-anf08",
        origem: ORIGEM,
        arquivo: ORIGEM.arquivos[0] as OrigemAcervo["arquivos"][number],
        bruto: adulterado,
        sha256Lock: sha256(bruto),
      }),
    ).toThrow(/ix\.xvii-p5|sha256/);
  });
});
