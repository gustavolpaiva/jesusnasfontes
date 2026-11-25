import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { parse, stringify } from "yaml";
import { obterPool } from "@/db/cliente";
import {
  type Derivado,
  type FonteYaml,
  interpretarDerivado,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import {
  carregarFontes,
  codigoDeSaida,
  executarCarga,
  type FonteParaCarga,
  TETO_DE_UNIDADES_POR_FONTE,
} from "../../../scripts/acervo/carregar";
import { linhasDeConflito } from "../../../scripts/db/build-producao";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { yamlSha256DoArquivo } from "../../support/entrada";

// O build de produção nunca apaga e nunca leva o conteúdo para trás (plano 02-22, revisão cruzada do Codex, CRÍTICA):
// um build de uma versão ANTERIOR (redeploy ou rollback na Vercel) carregava o derivado velho por cima do banco novo e
// apagava o que ele não tinha. Aqui: (a) derivado mais velho sobre banco mais novo não apaga nem sobrescreve, e avisa;
// (b) nada é apagado mesmo quando o derivado não tem uma seção; (c) outra Fonte fica intacta; (d) o teto aborta sem
// escrever. Banco descartável SÓ deste arquivo; não roda no Neon.

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
const temporarios: string[] = [];

const SHA = (c: string) => c.repeat(64);

function fonteDaFixture(
  slug = "josefo-antiguidades",
  soSecao18 = false,
  soSecao20 = false,
): FonteYaml {
  const y = interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
    "josefo-antiguidades.yaml",
  );
  const quer = soSecao18 ? "18" : soSecao20 ? "20" : null;
  return { ...y, slug, secoes: quer ? y.secoes.filter((x) => x.slug === quer) : y.secoes };
}
// biome-ignore lint/suspicious/noExplicitAny: o teste mexe no JSON bruto para fabricar derivados
function derivadoDaFixture(slug = "josefo-antiguidades", alterar?: (b: any) => void): Derivado {
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  bruto.slug = slug;
  alterar?.(bruto);
  return interpretarDerivado(bruto, `${slug}.json`);
}
const item = (
  revisao: number,
  sha: string,
  opcoes: {
    slug?: string;
    soSecao18?: boolean;
    soSecao20?: boolean;
    alterar?: (b: never) => void;
  } = {},
): FonteParaCarga => ({
  fonte: fonteDaFixture(opcoes.slug, opcoes.soSecao18, opcoes.soSecao20),
  derivado: derivadoDaFixture(opcoes.slug, opcoes.alterar as never),
  versao: { revisao, sha256: SHA(sha) },
});
// Derivado "novo": o texto de 18.63 revisado e um parágrafo a mais (18.65), que um derivado velho não tem.
const novo = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) => {
  const p0 = b.secoes[0]?.paragrafos[0] as { texto: string };
  p0.texto = `${p0.texto} (texto novo da revisão 2)`;
  b.secoes[0]?.paragrafos.push({
    ref: "18.65",
    texto: "Parágrafo que só existe no derivado novo.",
  });
};

async function linhas(sql: string, params: unknown[] = []) {
  return (await dono.query(sql, params)).rows;
}
const contar = async (sql: string, params: unknown[] = []) =>
  Number((await linhas(sql, params))[0]?.n ?? -1);
/** Fotografia do conteúdo de uma Fonte: se algo foi escrito ou apagado, ela muda. */
const foto = async (slug: string) =>
  JSON.stringify([
    await linhas(
      "select id, ordem, titulo, resumo_pt from acervo.fonte_secao where fonte_id = (select id from acervo.fonte where slug = $1) order by id",
      [slug],
    ),
    await linhas(
      `select p.id, p.secao_id, p.ordem, p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = $1 order by p.id`,
      [slug],
    ),
    await linhas(
      "select titulo, publicada, revisao, entrada_revisao, entrada_sha256 from acervo.fonte where slug = $1",
      [slug],
    ),
  ]);
const apagarTudo = async () => {
  await dono.query("delete from acervo.fonte_paragrafo");
  await dono.query("delete from acervo.fonte_secao");
  await dono.query("delete from acervo.fonte");
};

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
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(emNeon())("a carga nunca leva o conteúdo para trás nem apaga sozinha", () => {
  it("registra de qual revisão do derivado a Fonte foi carregada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const [f] = await linhas(
      "select entrada_revisao, entrada_sha256 from acervo.fonte where slug = 'josefo-antiguidades'",
    );
    expect(f).toEqual({ entrada_revisao: 1, entrada_sha256: SHA("a") });
  });

  it("(a) derivado MAIS VELHO sobre banco MAIS NOVO: nada é apagado, nada é sobrescrito, e avisa", async () => {
    await apagarTudo();
    // O banco tem a revisão 2 (texto revisado e o parágrafo 18.65)...
    await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(3);

    // ...e um build de uma versão anterior traz a revisão 1, sem o 18.65 e com o texto velho.
    const r = await carregarFontes([item(1, "a")], { cliente: carga });
    // O que importa primeiro: o banco. Nada apagado (o 18.65 continua), nada sobrescrito (o texto novo continua).
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(3);
    const [p] = await linhas(
      "select texto from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
    );
    expect(p?.texto).toContain("(texto novo da revisão 2)");
    expect(await foto("josefo-antiguidades")).toBe(antes);
    expect(r.inseridos + r.atualizados + r.removidos).toBe(0);
    expect(r.maisNovasNoBanco).toEqual([
      { slug: "josefo-antiguidades", revisaoDoBanco: 2, revisaoDoBuild: 1 },
    ]);
    // Pulada com aviso não é falha: o código de saída é 0.
    expect(
      codigoDeSaida({ carregadas: 1, puladas: [], resultado: r }),
      "pular por revisão mais nova é aviso, saída 0",
    ).toBe(0);
  });

  it("o comando inteiro (lock, aviso, saída 0): build de uma versão anterior imprime o aviso e não toca na Fonte", async () => {
    await apagarTudo();
    await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    const saida: string[] = [];
    const raiz = montarPastas(1);
    const r = await executarCarga(raiz.opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(0);
    expect(saida.find((l) => l.startsWith("aviso: josefo-antiguidades:"))).toContain(
      "o banco já tem a revisão 2 da entrada (derivado e YAML) e este build traz a 1",
    );
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("(b) o build nunca apaga, nem quando o derivado não tem uma seção ou um parágrafo que o banco tem", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);

    // Revisão NOVA (3) e derivado sem a seção 20 (e sem o parágrafo 20.197): o que o banco tem fica.
    const semSecao20 = (b: { secoes: unknown[] }) => {
      b.secoes.splice(1, 1);
    };
    const r = await carregarFontes(
      [item(3, "c", { soSecao18: true, alterar: semSecao20 as never })],
      { cliente: carga },
    );
    expect(r.removidos).toBe(0);
    expect(r.secoes.removidos + r.paragrafos.removidos).toBe(0);
    expect(r.mantidos).toEqual({ secoes: 1, paragrafos: 1 });
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(2);
    // O conteúdo ficou igual; só o registro da revisão carregada subiu para 3.
    const depois = JSON.parse(await foto("josefo-antiguidades")) as unknown[][];
    expect(depois.slice(0, 2)).toEqual((JSON.parse(antes) as unknown[][]).slice(0, 2));
    expect((depois[2] as { entrada_revisao: number }[])[0]?.entrada_revisao).toBe(3);
  });

  it("(b) o comando imprime que o que sumiu ficou e como apagar de propósito", async () => {
    await apagarTudo();
    // Revisão 3 completa no banco; a revisão 4 chega sem a seção 20 (derivado e YAML).
    await executarCarga(montarPastas(3).opcoes, { abrir: abrirCliente, escrever: () => {} });
    const saida: string[] = [];
    const r = await executarCarga(montarPastas(4, { semSecao20: true }).opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(0);
    expect(saida.join("\n")).toContain("ficaram no banco 1 parágrafos e 1 seções");
    expect(saida.join("\n")).toContain("--remover");
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);
  });

  it("a remoção é só de propósito: o id listado sai, o resto fica, e seção leva os parágrafos dela", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const semSecao20 = (b: { secoes: unknown[] }) => {
      b.secoes.splice(1, 1);
    };
    const r = await carregarFontes(
      [item(3, "c", { soSecao18: true, alterar: semSecao20 as never })],
      { cliente: carga, remocoesAutorizadas: ["secao:josefo-antiguidades/20"] },
    );
    expect(r.secoes.removidos).toBe(1);
    expect(r.paragrafos.removidos).toBe(1);
    expect(r.mantidos).toEqual({ secoes: 0, paragrafos: 0 });
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(1);
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(1);
  });

  it("autorização que não casa com nada (id errado) falha a carga inteira sem gravar", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([item(2, "b", { alterar: novo as never })], {
        cliente: carga,
        // 18.63 NÃO sumiu do derivado; 99.1 não existe.
        remocoesAutorizadas: [
          "paragrafo:josefo-antiguidades/18.63",
          "paragrafo:josefo-antiguidades/99.1",
        ],
      }),
    ).rejects.toThrow(/remoção autorizada que não se aplicou/);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("(c) controle negativo: outra Fonte fica intacta, com o derivado velho pulado e com a remoção autorizada em outra", async () => {
    await apagarTudo();
    const comExtra = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) =>
      b.secoes[0]?.paragrafos.push({ ref: "18.66", texto: "Só na outra." });
    // Josefo na revisão 2 (tem o 18.65); a outra Fonte na revisão 1, com um parágrafo (18.66) que o derivado dela
    // da revisão seguinte não terá.
    await carregarFontes(
      [
        item(2, "b", { alterar: novo as never }),
        item(1, "a", { slug: "outra-fonte", alterar: comExtra as never }),
      ],
      { cliente: carga },
    );
    const outraAntes = await foto("outra-fonte");
    const josefoAntes = await foto("josefo-antiguidades");

    // Josefo pulada (build velho, revisão 1 < 2); a outra avança de revisão sem o 18.66, e sem autorização ele fica.
    const r = await carregarFontes([item(1, "a"), item(2, "7", { slug: "outra-fonte" })], {
      cliente: carga,
    });
    expect(r.maisNovasNoBanco.map((x) => x.slug)).toEqual(["josefo-antiguidades"]);
    expect(r.mantidos).toEqual({ secoes: 0, paragrafos: 1 });
    expect(await foto("josefo-antiguidades")).toBe(josefoAntes);
    expect(
      await contar("select count(*) n from acervo.fonte_paragrafo where id = 'outra-fonte/18.66'"),
    ).toBe(1);

    // Remoção autorizada de UM id da Josefo (o 18.65 sai do derivado dela) não encosta na outra: o 18.66 dela fica.
    const outraDepois = await foto("outra-fonte");
    const r2 = await carregarFontes([item(3, "8"), item(2, "7", { slug: "outra-fonte" })], {
      cliente: carga,
      remocoesAutorizadas: ["paragrafo:josefo-antiguidades/18.65"],
    });
    expect(r2.paragrafos.removidos).toBe(1);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.65'",
      ),
    ).toBe(0);
    expect(await foto("outra-fonte")).toBe(outraDepois);
    expect(outraDepois).not.toBe(outraAntes); // controle: a outra tinha mesmo avançado de revisão no passo anterior
  });

  it("(d) o teto aborta a Fonte SEM nenhuma escrita: nada muda no banco, e a carga sai com 3", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    // Mais parágrafos novos que o teto padrão.
    const muitos = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) => {
      for (let i = 0; i < TETO_DE_UNIDADES_POR_FONTE + 10; i++)
        b.secoes[0]?.paragrafos.push({ ref: `18.${1000 + i}`, texto: `Parágrafo ${i}.` });
    };
    const r = await carregarFontes([item(2, "b", { alterar: muitos as never })], {
      cliente: carga,
    });
    expect(r.recusadasPeloTeto).toEqual([
      {
        slug: "josefo-antiguidades",
        unidades: TETO_DE_UNIDADES_POR_FONTE + 10,
        teto: TETO_DE_UNIDADES_POR_FONTE,
      },
    ]);
    expect(r.inseridos + r.atualizados + r.removidos).toBe(0);
    expect(await foto("josefo-antiguidades")).toBe(antes);
    expect(codigoDeSaida({ carregadas: 1, puladas: [], resultado: r })).toBe(3);
  });

  it("(d) a linha da recusa pelo teto é a que o build imprime como aviso, e o outro Fonte da mesma carga é carregada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const raiz = montarPastas(2, { muitos: true });
    const saida: string[] = [];
    const r = await executarCarga(raiz.opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(3);
    const avisos = linhasDeConflito(saida.join("\n"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("recusada: josefo-antiguidades escreveria");
    expect(avisos[0]).toContain("--teto");
    // Nada foi escrito: o banco segue na revisão 1.
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(2);
  });

  it("(d) o teto vale por unidade escrita: exatamente no teto passa, um a mais não", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    // A revisão 2 muda 1 parágrafo e insere 1 (2 unidades).
    const dentro = await carregarFontes([item(2, "b", { alterar: novo as never })], {
      cliente: carga,
      tetoDeUnidades: 2,
    });
    expect(dentro.recusadasPeloTeto).toEqual([]);
    expect(dentro.paragrafos.inseridos + dentro.paragrafos.atualizados).toBe(2);
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const fora = await carregarFontes([item(2, "b", { alterar: novo as never })], {
      cliente: carga,
      tetoDeUnidades: 1,
    });
    expect(fora.recusadasPeloTeto).toHaveLength(1);
    expect(fora.paragrafos.inseridos + fora.paragrafos.atualizados).toBe(0);
  });

  it("Fonte nova (primeira carga) não tem teto: só insere", async () => {
    await apagarTudo();
    const r = await carregarFontes([item(1, "a")], { cliente: carga, tetoDeUnidades: 1 });
    expect(r.recusadasPeloTeto).toEqual([]);
    expect(r.paragrafos.inseridos).toBe(2);
  });

  it("mesma revisão com outro sha256 é erro (a revisão tem de subir quando o derivado muda) e nada é gravado", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([item(1, "e", { alterar: novo as never })], { cliente: carga }),
    ).rejects.toThrow(ErroCarga);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("Fonte carregada antes da migração (sem revisão registrada) é aceita e passa a ter a revisão registrada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    await dono.query(
      "update acervo.fonte set entrada_revisao = null, entrada_sha256 = null where slug = 'josefo-antiguidades'",
    );
    await carregarFontes([item(5, "f")], { cliente: carga });
    const [f] = await linhas(
      "select entrada_revisao, entrada_sha256 from acervo.fonte where slug = 'josefo-antiguidades'",
    );
    expect(f).toEqual({ entrada_revisao: 5, entrada_sha256: SHA("f") });
  });

  it("revisão maior, mesmo derivado antigo: a Fonte avança e a revisão registrada sobe", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const r = await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    expect(r.maisNovasNoBanco).toEqual([]);
    expect(r.paragrafos.atualizados).toBe(1);
    expect(r.paragrafos.inseridos).toBe(1);
    expect(await contar("select count(*) n from acervo.fonte where entrada_revisao = 2")).toBe(1);
  });
});

// ───────────────────────── o comando, com lock e pastas temporárias ─────────────────────────

const abrirCliente = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await c.connect();
  return c;
};

/** Pastas temporárias com a Fonte de fixture, o derivado e um lock com a revisão pedida (sha256 e bytes de verdade). */
function montarPastas(
  revisao: number,
  como: {
    semSecao20?: boolean;
    muitos?: boolean;
    titulo?: string;
    outra?: { revisao: number; titulo?: string };
    /** O YAML foi editado e o lock ficou com o sha256 do YAML anterior (faltou `pnpm acervo:travar`). */
    semTravar?: boolean;
  } = {},
): { opcoes: { fontes: string; derivados: string; lock: string } } {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-nunca-tras-"));
  temporarios.push(raiz);
  const fontes = path.join(raiz, "fontes");
  const derivados = path.join(raiz, "derivados");
  mkdirSync(fontes);
  mkdirSync(derivados);
  cpSync(path.join(FIXTURES, "fontes"), fontes, { recursive: true });
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  ) as { secoes: { paragrafos: { ref: string; texto: string }[] }[] };
  if (como.semSecao20) {
    bruto.secoes.splice(1, 1);
    // O YAML da Fonte também deixa de listar a seção 20 (o contrato exige que toda seção do YAML exista no derivado).
    const arquivo = path.join(fontes, "josefo-antiguidades.yaml");
    const y = parse(readFileSync(arquivo, "utf8")) as { secoes: { slug: string }[] };
    y.secoes = y.secoes.filter((x) => x.slug !== "20");
    writeFileSync(arquivo, stringify(y));
  }
  const yamlOriginal = yamlSha256DoArquivo(path.join(fontes, "josefo-antiguidades.yaml"));
  if (como.titulo) {
    // Só o YAML muda (o derivado é o mesmo): a correção de um título.
    const arquivo = path.join(fontes, "josefo-antiguidades.yaml");
    writeFileSync(
      arquivo,
      readFileSync(arquivo, "utf8").replace(/^titulo: .*$/m, `titulo: ${como.titulo}`),
    );
  }
  if (como.muitos)
    for (let i = 0; i < TETO_DE_UNIDADES_POR_FONTE + 10; i++)
      bruto.secoes[0]?.paragrafos.push({ ref: `18.${1000 + i}`, texto: `Parágrafo ${i}.` });
  const json = JSON.stringify(bruto);
  writeFileSync(path.join(derivados, "josefo-antiguidades.json"), json);
  const lock = path.join(raiz, "lock.json");
  writeFileSync(
    lock,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {
        "josefo-antiguidades": {
          sha256: createHash("sha256").update(json).digest("hex"),
          bytes: Buffer.byteLength(json),
          yaml_sha256: como.semTravar
            ? yamlOriginal
            : yamlSha256DoArquivo(path.join(fontes, "josefo-antiguidades.yaml")),
          revisao,
        },
      },
    }),
  );
  if (como.outra) {
    // Uma segunda Fonte, cópia da primeira com outro slug (o derivado e o YAML dela, e a entrada dela no lock).
    const yamlOutra = path.join(fontes, "outra-fonte.yaml");
    let texto = readFileSync(path.join(fontes, "josefo-antiguidades.yaml"), "utf8").replace(
      /^slug: .*$/m,
      "slug: outra-fonte",
    );
    if (como.outra.titulo) texto = texto.replace(/^titulo: .*$/m, `titulo: ${como.outra.titulo}`);
    writeFileSync(yamlOutra, texto);
    const jsonOutra = JSON.stringify({ ...bruto, slug: "outra-fonte" });
    writeFileSync(path.join(derivados, "outra-fonte.json"), jsonOutra);
    const lido = JSON.parse(readFileSync(lock, "utf8"));
    lido.derivados["outra-fonte"] = {
      sha256: createHash("sha256").update(jsonOutra).digest("hex"),
      bytes: Buffer.byteLength(jsonOutra),
      yaml_sha256: yamlSha256DoArquivo(yamlOutra),
      revisao: como.outra.revisao,
    };
    writeFileSync(lock, JSON.stringify(lido));
  }
  return { opcoes: { fontes, derivados, lock } };
}

// ───────────────────────── segunda revisão cruzada: posições, YAML e remoção tipada ─────────────────────────

type B = { secoes: { slug: string; paragrafos: { ref: string; texto: string }[] }[] };
const refs = (...rs: string[]) => rs.map((ref) => ({ ref, texto: `Texto do parágrafo ${ref}.` }));
/** O derivado com a seção 18 trocada pelos parágrafos pedidos (nesta ordem). */
const secao18 =
  (...rs: string[]) =>
  (b: B) => {
    (b.secoes[0] as B["secoes"][number]).paragrafos = refs(...rs);
  };
/** A posição e o texto de cada parágrafo de uma seção, na ordem da posição. */
const ordens = async (secao: string) =>
  (
    await linhas(
      "select id, ordem, texto from acervo.fonte_paragrafo where secao_id = $1 order by ordem",
      [secao],
    )
  ).map((r) => `${r.ordem}:${r.id.split("/")[1]}`);

describe.skipIf(emNeon())(
  "posições: o retido nunca herda a posição do que o derivado inseriu",
  () => {
    it("o exemplo da revisão: A/B/C no banco e A/C no derivado: B fica (sem apagar), C vai para a posição 2, B para a 3", async () => {
      await apagarTudo();
      await carregarFontes([item(1, "a", { alterar: secao18("18.1", "18.2", "18.3") as never })], {
        cliente: carga,
      });
      expect(await ordens("josefo-antiguidades/18")).toEqual(["1:18.1", "2:18.2", "3:18.3"]);
      const r = await carregarFontes(
        [item(2, "b", { alterar: secao18("18.1", "18.3") as never })],
        { cliente: carga },
      );
      // Antes da correção: violação da restrição UNIQUE (secao_id, ordem) e a carga inteira revertida (o build quebrava).
      expect(await ordens("josefo-antiguidades/18")).toEqual(["1:18.1", "2:18.3", "3:18.2"]);
      expect(r.mantidos).toEqual({ secoes: 0, paragrafos: 1 });
      expect(r.removidos).toBe(0);
      const [b] = await linhas(
        "select texto from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.2'",
      );
      expect(b?.texto).toBe("Texto do parágrafo 18.2.");
    });

    it("vários retidos e inserções entre eles: todas as posições distintas, o derivado na sua ordem, o retido intacto", async () => {
      await apagarTudo();
      await carregarFontes(
        [
          item(1, "a", {
            alterar: secao18("18.1", "18.2", "18.3", "18.4", "18.5", "18.6") as never,
          }),
        ],
        { cliente: carga },
      );
      // O derivado novo: 18.1, duas novas, 18.4 e 18.6; ficam retidos o 18.2, o 18.3 e o 18.5.
      const r = await carregarFontes(
        [item(2, "b", { alterar: secao18("18.1", "18.90", "18.91", "18.4", "18.6") as never })],
        { cliente: carga },
      );
      const final = await ordens("josefo-antiguidades/18");
      const posicoes = final.map((x) => Number(x.split(":")[0]));
      expect(new Set(posicoes).size).toBe(posicoes.length);
      // O derivado, na ordem do derivado, nas posições 1 a 5.
      expect(final.slice(0, 5)).toEqual(["1:18.1", "2:18.90", "3:18.91", "4:18.4", "5:18.6"]);
      // Os três retidos depois, e nenhum foi apagado nem teve o texto mexido.
      expect(
        final
          .slice(5)
          .map((x) => x.split(":")[1])
          .sort(),
      ).toEqual(["18.2", "18.3", "18.5"]);
      expect(r.mantidos.paragrafos).toBe(3);
      expect(
        await contar(
          "select count(*) n from acervo.fonte_paragrafo where texto like 'Texto do parágrafo %'",
        ),
      ).toBe(8);
    });

    it("seção nova que ocuparia a posição de uma seção retida: a retida vai para o fim, sem colisão", async () => {
      await apagarTudo();
      await carregarFontes([item(1, "a")], { cliente: carga });
      // O derivado novo: a seção 20 vira 19 (a posição do derivado é 20, a mesma da retida, e o parágrafo 20.197 vai junto) e o YAML só lista a 18 e a 19.
      const renomear = (b: B & { secoes: { slug: string }[] }) => {
        (b.secoes[1] as { slug: string }).slug = "19";
      };
      const yaml19 = item(2, "b", { alterar: renomear as never });
      yaml19.fonte = {
        ...yaml19.fonte,
        secoes: yaml19.fonte.secoes.map((x) => (x.slug === "20" ? { ...x, slug: "19" } : x)),
      };
      const r = await carregarFontes([yaml19], { cliente: carga });
      expect(r.mantidos.secoes).toBe(1);
      const secoes = await linhas(
        "select slug, ordem from acervo.fonte_secao where fonte_id = (select id from acervo.fonte where slug = 'josefo-antiguidades') order by ordem",
      );
      expect(secoes.map((x) => `${x.ordem}:${x.slug}`)).toEqual(["18:18", "20:19", "21:20"]);
    });

    it("controle negativo: a posição de outra Fonte não é tocada", async () => {
      await apagarTudo();
      const tres = secao18("18.1", "18.2", "18.3") as never;
      await carregarFontes(
        [item(1, "a", { alterar: tres }), item(1, "a", { slug: "outra-fonte", alterar: tres })],
        { cliente: carga },
      );
      const outraAntes = await foto("outra-fonte");
      await carregarFontes(
        [
          item(2, "b", { alterar: secao18("18.1", "18.3") as never }),
          item(1, "a", { slug: "outra-fonte", alterar: tres }),
        ],
        { cliente: carga },
      );
      expect(await ordens("josefo-antiguidades/18")).toEqual(["1:18.1", "2:18.3", "3:18.2"]);
      expect(await foto("outra-fonte")).toBe(outraAntes);
    });

    it("o reposicionamento do retido conta para o teto de unidades (a Fonte é recusada, sem escrever)", async () => {
      await apagarTudo();
      await carregarFontes([item(1, "a", { alterar: secao18("18.1", "18.2", "18.3") as never })], {
        cliente: carga,
      });
      const antes = await foto("josefo-antiguidades");
      // Muda 1 (18.3 ganha a posição 2) e reposiciona 1 (18.2): 2 unidades. Teto 1: recusada.
      const r = await carregarFontes(
        [item(2, "b", { alterar: secao18("18.1", "18.3") as never })],
        { cliente: carga, tetoDeUnidades: 1 },
      );
      expect(r.recusadasPeloTeto).toEqual([{ slug: "josefo-antiguidades", unidades: 2, teto: 1 }]);
      expect(await foto("josefo-antiguidades")).toBe(antes);
    });
  },
);

describe.skipIf(emNeon())(
  "o YAML também é versionado: entrada mais velha nunca sobrescreve a mais nova",
  () => {
    const titulo = async () =>
      (await linhas("select titulo from acervo.fonte where slug = 'josefo-antiguidades'"))[0]
        ?.titulo;
    const rodar = (revisao: number, como: Parameters<typeof montarPastas>[1] = {}) => {
      const saida: string[] = [];
      return executarCarga(montarPastas(revisao, como).opcoes, {
        abrir: abrirCliente,
        escrever: (l) => saida.push(l),
      }).then((r) => ({ r, saida }));
    };

    it("uma versão corrige só o YAML (o derivado é o mesmo); o redeploy do build anterior NÃO desfaz a correção", async () => {
      await apagarTudo();
      // A: o YAML original, revisão 1. B: só o título corrigido no YAML, revisão 2 (o derivado é o mesmo).
      await rodar(1);
      await rodar(2, { titulo: "Título corrigido" });
      expect(await titulo()).toBe("Título corrigido");
      const antes = await foto("josefo-antiguidades");
      // O redeploy do build A: mesmo derivado (mesmo sha256), YAML velho, revisão 1.
      const { r, saida } = await rodar(1);
      expect(r.resultado?.maisNovasNoBanco).toEqual([
        { slug: "josefo-antiguidades", revisaoDoBanco: 2, revisaoDoBuild: 1 },
      ]);
      expect(saida.join("\n")).toContain("aviso: josefo-antiguidades: o banco já tem a revisão 2");
      expect(codigoDeSaida(r)).toBe(0);
      expect(await titulo()).toBe("Título corrigido");
      expect(await foto("josefo-antiguidades")).toBe(antes);
    });

    it("o YAML editado sem `pnpm acervo:travar` (a revisão não subiu) é recusado ANTES de abrir conexão", async () => {
      await apagarTudo();
      await rodar(1);
      const antes = await foto("josefo-antiguidades");
      let abriu = false;
      await expect(
        executarCarga(montarPastas(1, { titulo: "Título corrigido", semTravar: true }).opcoes, {
          abrir: async () => {
            abriu = true;
            return abrirCliente();
          },
          escrever: () => {},
        }),
      ).rejects.toThrow(/o YAML mudou sem a revisão subir/);
      expect(abriu).toBe(false);
      expect(await foto("josefo-antiguidades")).toBe(antes);
    });

    it("controle negativo: outra Fonte da mesma carga avança, e a velha é a única pulada", async () => {
      await apagarTudo();
      await rodar(2, { titulo: "Título corrigido", outra: { revisao: 1 } });
      const outraAntes = await foto("outra-fonte");
      // O build anterior: a josefo na revisão 1 (pulada); a outra na revisão 2, com título novo (avança).
      const { r } = await rodar(1, { outra: { revisao: 2, titulo: "Outra, revista" } });
      expect(r.resultado?.maisNovasNoBanco.map((x) => x.slug)).toEqual(["josefo-antiguidades"]);
      expect(await titulo()).toBe("Título corrigido");
      expect(await foto("outra-fonte")).not.toBe(outraAntes);
      const [o] = await linhas("select titulo from acervo.fonte where slug = 'outra-fonte'");
      expect(o?.titulo).toBe("Outra, revista");
    });
  },
);

describe.skipIf(emNeon())("remoção: autorização tipada e teto de remoções", () => {
  /** Estado: seção 18 (com o parágrafo 18.63) e seção 20; o parágrafo `18` (mesmo id da seção) na seção 20. */
  async function prepararColisao() {
    await apagarTudo();
    const comParagrafo18 = (b: B) => {
      (b.secoes[1] as B["secoes"][number]).paragrafos.push({
        ref: "18",
        texto: "Um parágrafo chamado 18.",
      });
    };
    await carregarFontes([item(1, "a", { alterar: comParagrafo18 as never })], { cliente: carga });
    expect(
      await contar("select count(*) n from acervo.fonte_secao where id = 'josefo-antiguidades/18'"),
    ).toBe(1);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18'",
      ),
    ).toBe(1);
  }
  // O derivado novo só tem a seção 20, e sem o parágrafo 18: somem a seção 18 (e o 18.63) e o parágrafo 18.
  const soSecao20 = (revisao: number, sha: string) =>
    item(revisao, sha, {
      soSecao20: true,
      alterar: ((b: B) => {
        b.secoes.splice(0, 1);
      }) as never,
    });

  it("`paragrafo:<id>` apaga SÓ o parágrafo, mesmo existindo uma seção com o mesmo id", async () => {
    await prepararColisao();
    const r = await carregarFontes([soSecao20(2, "b")], {
      cliente: carga,
      remocoesAutorizadas: ["paragrafo:josefo-antiguidades/18"],
    });
    expect(r.paragrafos.removidos).toBe(1);
    expect(r.secoes.removidos).toBe(0);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18'",
      ),
    ).toBe(0);
    // A seção 18 e o parágrafo 18.63 dela ficam.
    expect(
      await contar("select count(*) n from acervo.fonte_secao where id = 'josefo-antiguidades/18'"),
    ).toBe(1);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
      ),
    ).toBe(1);
    expect(r.mantidos).toEqual({ secoes: 1, paragrafos: 1 });
  });

  it("`secao:<id>` apaga a seção (e os parágrafos ausentes dela), e NÃO o parágrafo de mesmo id", async () => {
    await prepararColisao();
    const r = await carregarFontes([soSecao20(2, "b")], {
      cliente: carga,
      remocoesAutorizadas: ["secao:josefo-antiguidades/18"],
    });
    expect(r.secoes.removidos).toBe(1);
    expect(r.paragrafos.removidos).toBe(1); // o 18.63, que era da seção
    expect(
      await contar("select count(*) n from acervo.fonte_secao where id = 'josefo-antiguidades/18'"),
    ).toBe(0);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18'",
      ),
    ).toBe(1);
  });

  it("autorização SEM tipo é recusada e nada é gravado", async () => {
    await prepararColisao();
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([soSecao20(2, "b")], {
        cliente: carga,
        remocoesAutorizadas: ["josefo-antiguidades/18"],
      }),
    ).rejects.toThrow(/secao:<slug>\/<seção> ou paragrafo:<slug>\/<ref>/);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("o teto de remoções aborta SEM escrever: a seção leva 2 parágrafos, 3 unidades, teto 2", async () => {
    await prepararColisao();
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([soSecao20(2, "b")], {
        cliente: carga,
        remocoesAutorizadas: ["secao:josefo-antiguidades/18", "paragrafo:josefo-antiguidades/18"],
        tetoDeRemocoes: 2,
      }),
    ).rejects.toThrow(/acima do teto de 2/);
    expect(await foto("josefo-antiguidades")).toBe(antes);
    // No teto exato, passa.
    const r = await carregarFontes([soSecao20(2, "b")], {
      cliente: carga,
      remocoesAutorizadas: ["secao:josefo-antiguidades/18", "paragrafo:josefo-antiguidades/18"],
      tetoDeRemocoes: 3,
    });
    expect(r.removidos).toBe(3);
  });

  it("o teto padrão de remoções (50) vale para uma lista colada errada: 60 parágrafos autorizados, nada apagado", async () => {
    await apagarTudo();
    const muitos = (b: B) => {
      (b.secoes[0] as B["secoes"][number]).paragrafos = refs(
        ...Array.from({ length: 61 }, (_, i) => `18.${i + 1}`),
      );
    };
    await carregarFontes([item(1, "a", { alterar: muitos as never })], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    const autorizacoes = Array.from(
      { length: 60 },
      (_, i) => `paragrafo:josefo-antiguidades/18.${i + 2}`,
    );
    await expect(
      carregarFontes([item(2, "b", { alterar: secao18("18.1") as never })], {
        cliente: carga,
        remocoesAutorizadas: autorizacoes,
        tetoDeUnidades: 1000,
      }),
    ).rejects.toThrow(/acima do teto de 50/);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("controle negativo: o teto de remoções aborta a carga inteira, e outra Fonte também não recebe escrita", async () => {
    await prepararColisao();
    await carregarFontes([item(1, "a", { slug: "outra-fonte" })], { cliente: carga });
    const outraAntes = await foto("outra-fonte");
    await expect(
      carregarFontes(
        [
          item(2, "b", { slug: "outra-fonte", alterar: secao18("18.63", "18.99") as never }),
          soSecao20(2, "b"),
        ],
        {
          cliente: carga,
          remocoesAutorizadas: ["secao:josefo-antiguidades/18"],
          tetoDeRemocoes: 1,
        },
      ),
    ).rejects.toThrow(ErroCarga);
    expect(await foto("outra-fonte")).toBe(outraAntes);
  });
});
