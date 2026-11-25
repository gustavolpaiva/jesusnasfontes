import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { montarCreditos } from "@/modules/creditos/creditos";

// A página de créditos é gerada dos registros (ACER-12): toda entrada de cada registro aparece com
// autores, licença e versão, o crédito literal da Bíblia Livre é idêntico ao do registro, e cada
// origem do Acervo que alimenta uma Fonte publicada tem a sua entrada, com "Usado em" e links.
// Nenhum número do Acervo é fixo: tudo é derivado do registro de origens e dos YAMLs de Fonte.

type Origem = {
  nome: string;
  autores: string[];
  licenca: string;
  url_licenca: string;
  fonte: string;
  commit: string;
  data_versao: string;
  alteracoes: string;
  publicavel: boolean;
  arquivos: { slug: string }[];
};
type Fonte = {
  slug: string;
  titulo: string;
  publicada: boolean;
  tipo_texto: string;
};

const registro = (arquivo: string) => parse(readFileSync(join("data", arquivo), "utf8"));
const datasets = registro("datasets.yaml") as Record<
  string,
  {
    nome: string;
    autores: string[];
    licenca: string;
    url_licenca: string;
    commit: string;
    data_versao: string;
    credito_literal?: string;
    alteracoes: string;
  }
>;
const tipografia = registro("tipografia.yaml") as {
  commit: string;
  fontes: { familia: string; autores: string; licenca: string; alteracoes: string }[];
};
const proprios = registro("creditos-proprios.yaml") as {
  licencas: Record<string, string>;
  entradas: {
    nome: string;
    autores: string[];
    licenca: string;
    versao: string;
    alteracoes: string;
  }[];
};
const origens = registro("acervo-origens.yaml") as Record<string, Origem>;

const PASTA_FONTES = join("content", "acervo", "fontes");
function fontesDe(pasta: string): Fonte[] {
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith(".yaml"))
    .sort()
    .map((nome) => parse(readFileSync(join(pasta, nome), "utf8")) as Fonte);
}
const fontes = fontesDe(PASTA_FONTES);

/** As Fontes de texto integral PUBLICADAS que a origem alimenta (o que o site usa dela). */
const publicadasDe = (o: Origem): Fonte[] =>
  o.arquivos
    .map((a) => fontes.find((f) => f.slug === a.slug))
    .filter((f): f is Fonte => f?.publicada === true && f.tipo_texto === "integral");
const ordemDoAcervo = (a: Fonte, b: Fonte) => a.titulo.localeCompare(b.titulo, "pt-BR");
const origensUsadas = Object.entries(origens).filter(([, o]) => publicadasDe(o).length > 0);
// O que a Fase 1 tinha: a soma dos três registros antigos (nenhum número escrito aqui).
const ANTIGAS = Object.keys(datasets).length + proprios.entradas.length + tipografia.fontes.length;

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});
const temporaria = (prefixo: string) => {
  const pasta = mkdtempSync(join(tmpdir(), prefixo));
  pastas.push(pasta);
  return pasta;
};

// Cópia dos quatro registros numa pasta temporária, para os testes que adulteram um deles.
function copiaDosRegistros(): string {
  const pasta = temporaria("jnf-creditos-");
  for (const a of [
    "datasets.yaml",
    "tipografia.yaml",
    "creditos-proprios.yaml",
    "acervo-origens.yaml",
  ])
    cpSync(join("data", a), join(pasta, a));
  return pasta;
}
// Cópia dos YAMLs de Fonte, para os testes que acrescentam uma Fonte.
function copiaDasFontes(): string {
  const pasta = temporaria("jnf-creditos-fontes-");
  cpSync(PASTA_FONTES, pasta, { recursive: true });
  return pasta;
}

const dataBrasileira = (iso: string) => iso.split("-").reverse().join("/");

describe("montarCreditos", () => {
  const entradas = montarCreditos();
  const geral = entradas.filter((e) => e.grupo === "geral");
  const acervo = entradas.filter((e) => e.grupo === "acervo");
  const porNome = (nome: string) => entradas.find((e) => e.nome === nome);
  const daOrigem = (id: string) => porNome((origens[id] as Origem).nome);

  it("lista as cinco entradas da Fase 1 primeiro, na ordem do contrato, e intactas", () => {
    expect(geral.map((e) => e.nome)).toEqual([
      "Bíblia Livre (BLIVRE)",
      "Conteúdo dos Estudos",
      "Código",
      "EB Garamond",
      "Cormorant Garamond",
    ]);
    // Intactas: sem "Usado em" e com os autores numa linha só, como antes.
    for (const e of geral) {
      expect(e.usadoEm).toEqual([]);
      expect(e.autores).toHaveLength(1);
    }
  });

  it("o número de entradas é a soma dos registros antigos com as origens do Acervo que o site usa", () => {
    expect(ANTIGAS).toBe(5);
    expect(origensUsadas.length).toBeGreaterThan(0);
    expect(entradas).toHaveLength(ANTIGAS + origensUsadas.length);
  });

  it("uma entrada por origem que alimenta Fonte publicada, na ordem do registro, depois das da Fase 1", () => {
    expect(acervo.map((e) => e.nome)).toEqual(origensUsadas.map(([, o]) => o.nome));
    expect(entradas).toEqual([...geral, ...acervo]);
  });

  it("toda entrada de datasets.yaml aparece com autores, licença, versão e alterações do registro", () => {
    for (const d of Object.values(datasets)) {
      const e = porNome(d.nome);
      expect(e, d.nome).toBeDefined();
      for (const autor of d.autores) expect(e?.autores.join(" ")).toContain(autor);
      expect(e?.licenca).toBe(d.licenca);
      expect(e?.urlLicenca).toBe(d.url_licenca);
      expect(e?.versao).toContain(d.commit.slice(0, 7));
      expect(e?.versao).toContain(d.data_versao.split("-").reverse().join("/"));
      expect(e?.alteracoes).toBe(d.alteracoes);
    }
  });

  it("o crédito literal da Bíblia Livre é idêntico ao do registro", () => {
    const d = Object.values(datasets).find((x) => x.credito_literal);
    expect(d?.credito_literal).toBeTruthy();
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toBe(d?.credito_literal);
    // O texto cita fonte e autores: nenhum pedaço da atribuição ficou de fora.
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toContain("Diego Santos");
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toContain(
      "Creative Commons Atribuição 3.0 Brasil",
    );
  });

  it("toda fonte de tipografia.yaml aparece com autores, licença, versão e alterações do registro", () => {
    for (const f of tipografia.fontes) {
      const e = porNome(f.familia);
      expect(e, f.familia).toBeDefined();
      expect(e?.autores.join(" ")).toBe(f.autores);
      expect(e?.licenca).toBe(f.licenca);
      expect(e?.urlLicenca).toBe(proprios.licencas[f.licenca]);
      expect(e?.versao).toContain(tipografia.commit.slice(0, 7));
      expect(e?.alteracoes).toBe(f.alteracoes);
    }
  });

  it("toda entrada de creditos-proprios.yaml aparece com autores, licença, versão e alterações", () => {
    for (const p of proprios.entradas) {
      const e = porNome(p.nome);
      expect(e, p.nome).toBeDefined();
      for (const autor of p.autores) expect(e?.autores.join(" ")).toContain(autor);
      expect(e?.licenca).toBe(p.licenca);
      expect(e?.versao).toBe(p.versao);
      expect(e?.alteracoes).toBe(p.alteracoes);
    }
    // O conteúdo (CC BY-SA 4.0) e o código (MIT) batem com os arquivos de licença do repositório.
    expect(readFileSync("content/LICENSE", "utf8")).toContain(
      "Attribution-ShareAlike 4.0 International",
    );
    expect(porNome("Conteúdo dos Estudos")?.licenca).toBe("CC BY-SA 4.0");
    expect(readFileSync("LICENSE", "utf8")).toMatch(/^MIT License/);
    expect(porNome("Código")?.licenca).toBe("MIT");
  });

  it("nenhuma entrada sai com campo vazio", () => {
    for (const e of entradas) {
      for (const campo of [e.nome, e.licenca, e.versao, e.alteracoes]) {
        expect(campo.trim().length, e.nome).toBeGreaterThan(0);
      }
      expect(e.autores.length, e.nome).toBeGreaterThan(0);
      for (const autor of e.autores) expect(autor.trim().length, e.nome).toBeGreaterThan(0);
      for (const f of e.usadoEm) {
        expect(f.slug.trim().length, e.nome).toBeGreaterThan(0);
        expect(f.titulo.trim().length, e.nome).toBeGreaterThan(0);
      }
    }
  });

  it("do Acervo: autores, endereço da licença, versão e alterações vêm do registro de origens", () => {
    for (const [id, o] of origensUsadas) {
      const e = daOrigem(id);
      expect(e, id).toBeDefined();
      // As linhas de autor do registro vêm primeiro, na ordem; o que vier depois é tradução (teste abaixo).
      expect(e?.autores.slice(0, o.autores.length)).toEqual(o.autores);
      expect(e?.urlLicenca).toBe(o.url_licenca);
      expect(e?.alteracoes).toBe(o.alteracoes);
      expect(e?.versao).toContain(o.commit.slice(0, 7));
      expect(e?.versao).toContain(dataBrasileira(o.data_versao));
      expect(e?.creditoLiteral).toBeNull();
    }
  });

  it("'Usado em' traz as Fontes publicadas da origem, na ordem alfabética portuguesa do Acervo", () => {
    for (const [id, o] of origensUsadas) {
      expect(daOrigem(id)?.usadoEm, id).toEqual(
        publicadasDe(o)
          .sort(ordemDoAcervo)
          .map((f) => ({ slug: f.slug, titulo: f.titulo })),
      );
    }
  });

  it("toda Fonte publicada está no 'Usado em' de exatamente uma entrada, e toda entrada do Acervo tem ao menos um link", () => {
    const listadas = acervo.flatMap((e) => e.usadoEm.map((f) => f.slug));
    const publicadas = fontes.filter((f) => f.publicada).map((f) => f.slug);
    expect(listadas.sort()).toEqual(publicadas.sort());
    expect(new Set(listadas).size).toBe(listadas.length);
    for (const e of acervo) expect(e.usadoEm.length, e.nome).toBeGreaterThan(0);
  });

  it("a Fonte não publicada nunca entra em 'Usado em'", () => {
    const naoPublicadas = fontes.filter((f) => !f.publicada).map((f) => f.slug);
    expect(naoPublicadas.length).toBeGreaterThan(0);
    for (const slug of naoPublicadas)
      expect(acervo.flatMap((e) => e.usadoEm.map((f) => f.slug))).not.toContain(slug);
  });

  it("o que o BANCO diz publicado vale sobre o YAML: Fonte despublicada pelo painel perde o link de 'Usado em'", () => {
    const publicadas = fontes.filter((f) => f.publicada).map((f) => f.slug);
    // Controle: com o banco igual ao YAML, a página é a mesma.
    expect(montarCreditos({ publicadasNoBanco: new Set(publicadas) })).toEqual(entradas);

    // O painel despublica uma Fonte de uma origem que tem outras (Perseus: Josefo tem duas)...
    const alvo = "josefo-antiguidades";
    expect(acervo.flatMap((e) => e.usadoEm.map((f) => f.slug))).toContain(alvo);
    const depois = montarCreditos({
      publicadasNoBanco: new Set(publicadas.filter((slug) => slug !== alvo)),
    });
    const links = depois.flatMap((e) => e.usadoEm.map((f) => f.slug));
    expect(links).not.toContain(alvo);
    // ...e só ela some: todas as outras continuam, na mesma ordem.
    expect(links).toEqual(
      acervo.flatMap((e) => e.usadoEm.map((f) => f.slug)).filter((slug) => slug !== alvo),
    );
  });

  it("origem cuja única Fonte foi despublicada no banco perde a entrada inteira", () => {
    const [id, o] = origensUsadas.find(([, x]) => publicadasDe(x).length === 1) ?? [];
    expect(id, "há origem com uma só Fonte publicada").toBeDefined();
    const unica = publicadasDe(o as Origem)[0]?.slug;
    const publicadas = fontes.filter((f) => f.publicada).map((f) => f.slug);
    const depois = montarCreditos({
      publicadasNoBanco: new Set(publicadas.filter((slug) => slug !== unica)),
    });
    expect(depois.find((e) => e.nome === (o as Origem).nome)).toBeUndefined();
    expect(depois).toHaveLength(entradas.length - 1);
  });

  it("banco sem nenhuma Fonte publicada: sai só o que é da Fase 1, sem erro", () => {
    const depois = montarCreditos({ publicadasNoBanco: new Set() });
    expect(depois).toEqual(geral);
  });

  it("Fonte sem origem no registro, que o painel publicou: não derruba a página e não ganha link", () => {
    const pasta = copiaDosRegistros();
    const fontesNovas = copiaDasFontes();
    // Uma Fonte que nenhuma origem alimenta, NÃO publicada no YAML (o build passa) e publicada pelo painel (o banco diz sim).
    const modelo = readdirSync(fontesNovas).find((n) => n.endsWith(".yaml")) as string;
    const texto = readFileSync(join(fontesNovas, modelo), "utf8")
      .replace(/^slug: .*$/m, "slug: fonte-sem-origem")
      .replace(/^publicada: .*$/m, "publicada: false");
    expect(texto).toContain("publicada: false");
    writeFileSync(join(fontesNovas, "fonte-sem-origem.yaml"), texto);
    const publicadas = fontes.filter((f) => f.publicada).map((f) => f.slug);
    const montadas = montarCreditos({
      diretorio: pasta,
      diretorioFontes: fontesNovas,
      publicadasNoBanco: new Set([...publicadas, "fonte-sem-origem"]),
    });
    expect(montadas.flatMap((e) => e.usadoEm.map((f) => f.slug))).not.toContain("fonte-sem-origem");
    // No build (o YAML decide) a mesma Fonte, publicada no YAML, derruba a geração.
    writeFileSync(
      join(fontesNovas, "fonte-sem-origem.yaml"),
      texto.replace(/^publicada: .*$/m, "publicada: true"),
    );
    expect(() => montarCreditos({ diretorio: pasta, diretorioFontes: fontesNovas })).toThrow(
      /fonte-sem-origem/,
    );
  });

  it("origem sem Fonte publicada não ganha entrada: o site não usa texto dela", () => {
    const semUso = Object.entries(origens).filter(([, o]) => publicadasDe(o).length === 0);
    // Controle positivo: há origem nessa situação no registro (as barradas de licença).
    expect(semUso.length).toBeGreaterThan(0);
    for (const [id, o] of semUso) expect(porNome(o.nome), id).toBeUndefined();
  });

  it("a origem do Perseus mostra a licença da edição digital e a da tradução separadas", () => {
    expect(daOrigem("perseus-greeklit-josefo")?.licenca).toBe(
      "Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.",
    );
    expect(daOrigem("perseus-latinlit-tacito")?.licenca).toBe(
      "Edição digital: CC BY-SA 4.0. Tradução de Alfred John Church e William Jackson Brodribb, 1869: domínio público.",
    );
    expect(daOrigem("perseus-greeklit-luciano")?.licenca).toBe(
      "Edição digital: CC BY-SA. Tradução de Henry Watson Fowler e Francis George Fowler, 1905: domínio público.",
    );
    expect(daOrigem("perseus-greeklit-josefo")?.urlLicenca).toBe(
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });

  it("Mattison aparece com a dedicação ao domínio público", () => {
    const e = daOrigem("gospels-net-tome-mattison");
    expect(e?.licenca).toBe("Domínio público, dedicado pelo tradutor");
    expect(e?.urlLicenca).toBe("https://www.gospels.net/thomas");
    expect(e?.usadoEm).toEqual([{ slug: "evangelho-de-tome", titulo: "Evangelho de Tomé" }]);
    expect(e?.autores.join(" ")).toContain("Mark M. Mattison");
  });

  it("o CCEL aparece em domínio público, pelo vocabulário fechado das próprias Fontes", () => {
    // A mesma frase que a página de cada Fonte mostra: ANF 01 é tradução anterior a 1929; os demais volumes,
    // domínio público declarado pela origem.
    expect(daOrigem("ccel-anf01")?.licenca).toBe("Domínio público (tradução anterior a 1929)");
    for (const id of Object.keys(origens).filter((k) => k.startsWith("ccel-"))) {
      const usadas = publicadasDe(origens[id] as Origem);
      if (usadas.length === 0) continue;
      expect(daOrigem(id)?.licenca, id).toMatch(/^Domínio público/);
      expect(daOrigem(id)?.urlLicenca, id).toMatch(/^https:\/\/ccel\.org\//);
    }
  });

  it("o endereço de origem é o do registro, sem sufixo de árvore, quando não é repositório", () => {
    for (const [id, o] of origensUsadas) {
      const esperado = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(o.fonte)
        ? `${o.fonte}/tree/${o.commit}`
        : o.fonte;
      expect(daOrigem(id)?.urlOrigem, id).toBe(esperado);
    }
    // Um de cada família.
    expect(daOrigem("perseus-greeklit-josefo")?.urlOrigem).toBe(
      "https://github.com/PerseusDL/canonical-greekLit/tree/dacb04909e43dc47738828d33cc3d2b0635bc54c",
    );
    expect(daOrigem("ccel-anf08")?.urlOrigem).toBe("https://ccel.org/ccel/schaff/anf08");
    expect(daOrigem("gutenberg-plinio-2811")?.urlOrigem).toBe(
      "https://gutenberg.pglaf.org/2/8/1/2811/",
    );
    expect(daOrigem("gospels-net-tome-mattison")?.urlOrigem).toBe("https://www.gospels.net/thomas");
  });

  it("a versão nomeia o commit quando a origem versiona e a impressão sha256 do arquivo quando não versiona", () => {
    expect(daOrigem("perseus-greeklit-josefo")?.versao).toBe("commit dacb049, de 13/11/2026");
    expect(daOrigem("ccel-anf08")?.versao).toBe("sha256 2e18deb94f36 do arquivo, de 24/11/2026");
  });

  it("o 'Usado em' de cada origem é o que o próprio derivado declara (origem_id)", () => {
    const lock = JSON.parse(readFileSync("data/acervo-derivados.lock.json", "utf8")) as {
      derivados: Record<string, unknown>;
    };
    const slugs = Object.keys(lock.derivados).sort();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const d = JSON.parse(
        readFileSync(join("data", "acervo-derivados", `${slug}.json`), "utf8"),
      ) as { slug: string; origem_id: string };
      const origem = origens[d.origem_id];
      expect(origem, `derivado ${slug}`).toBeDefined();
      expect(
        daOrigem(d.origem_id)?.usadoEm.map((f) => f.slug),
        `derivado ${slug}`,
      ).toContain(slug);
    }
  });

  it("os tradutores das obras entram em Autores quando o registro só nomeia o editor e a biblioteca", () => {
    const anf09 = daOrigem("ccel-anf09");
    const linhas = anf09?.autores ?? [];
    expect(linhas.slice(0, (origens["ccel-anf09"] as Origem).autores.length)).toEqual(
      (origens["ccel-anf09"] as Origem).autores,
    );
    expect(linhas.at(-1)).toMatch(/^Tradução de [^;]+(; [^;]+)*$/);
    for (const tradutor of [
      "Rev. Hope W. Hogg, B.D.",
      "D. M. Kay",
      "J. Armitage Robinson",
      "Andrew Rutherford, B.D.",
    ])
      expect(linhas.at(-1)).toContain(tradutor);
  });

  it("a linha de tradução nunca termina em ponto dobrado quando o nome acaba em abreviatura", () => {
    // "Rev. Frederick Crombie, D.D." já acaba em ponto: a linha não acrescenta outro.
    expect(daOrigem("ccel-anf04")?.autores.at(-1)).toBe("Tradução de Rev. Frederick Crombie, D.D.");
    for (const e of acervo) for (const linha of e.autores) expect(linha).not.toMatch(/\.\.$/);
  });

  it("quem o registro já nomeia como tradutor não é repetido", () => {
    for (const id of [
      "perseus-greeklit-josefo",
      "perseus-latinlit-tacito",
      "perseus-greeklit-luciano",
      "gutenberg-plinio-2811",
      "gospels-net-tome-mattison",
      "ccel-npnf201",
    ]) {
      expect(daOrigem(id)?.autores, id).toEqual((origens[id] as Origem).autores);
    }
  });
});

describe("a página nasce dos registros", () => {
  it("uma entrada nova num registro aparece sem mexer em código (controle contra texto escrito à mão)", () => {
    const pasta = copiaDosRegistros();
    const arquivo = join(pasta, "creditos-proprios.yaml");
    writeFileSync(
      arquivo,
      `${readFileSync(arquivo, "utf8")}  - nome: Entrada de teste\n    autores: [Alguém]\n    licenca: MIT\n    versao: "1"\n    alteracoes: Nenhuma.\n`,
    );
    const nomes = montarCreditos({ diretorio: pasta }).map((e) => e.nome);
    expect(nomes).toContain("Entrada de teste");
    expect(nomes).toHaveLength(ANTIGAS + 1 + origensUsadas.length);
  });

  it("uma origem nova, com uma Fonte publicada nova, aparece sem mexer em código", () => {
    const pasta = copiaDosRegistros();
    const fontesNovas = copiaDasFontes();
    writeFileSync(
      join(fontesNovas, "obra-nova.yaml"),
      `slug: obra-nova
titulo: Obra Nova de Teste
nivel: primaria
tipo_texto: integral
idioma: en
publicada: true
licenca: dp-declarado-pela-origem
licenca_url: https://example.test/licenca
origem_nome: Origem Nova
origem_url: https://example.test/obra
tradutor: Fulana de Tal
edicao: Edição de teste
`,
    );
    const reg = parse(readFileSync(join(pasta, "acervo-origens.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    reg["origem-nova"] = {
      nome: "Origem Nova de Teste",
      autores: ["Biblioteca de Teste (edição digital)"],
      licenca: "Domínio público",
      url_licenca: "https://example.test/licenca",
      fonte: "https://example.test/obra",
      commit: "a".repeat(64),
      data_versao: "2026-01-02",
      alteracoes: "Nenhuma.",
      arquivos: [{ slug: "obra-nova" }],
    };
    writeFileSync(join(pasta, "acervo-origens.yaml"), stringify(reg));
    const montadas = montarCreditos({ diretorio: pasta, diretorioFontes: fontesNovas });
    const e = montadas.find((x) => x.nome === "Origem Nova de Teste");
    expect(montadas).toHaveLength(ANTIGAS + origensUsadas.length + 1);
    expect(e?.grupo).toBe("acervo");
    expect(e?.autores).toEqual([
      "Biblioteca de Teste (edição digital)",
      "Tradução de Fulana de Tal",
    ]);
    expect(e?.licenca).toBe("Domínio público, como declara a origem");
    expect(e?.urlLicenca).toBe("https://example.test/licenca");
    expect(e?.versao).toBe("sha256 aaaaaaaaaaaa do arquivo, de 02/01/2026");
    expect(e?.urlOrigem).toBe("https://example.test/obra");
    expect(e?.usadoEm).toEqual([{ slug: "obra-nova", titulo: "Obra Nova de Teste" }]);
  });

  it("registro com campo faltando derruba a geração, em vez de cortar a atribuição", () => {
    const pasta = copiaDosRegistros();
    const arquivo = join(pasta, "datasets.yaml");
    writeFileSync(arquivo, readFileSync(arquivo, "utf8").replace(/^ {2}licenca: .*$/m, ""));
    expect(() => montarCreditos({ diretorio: pasta })).toThrow();
  });

  it.each([
    "nome",
    "autores",
    "licenca",
    "url_licenca",
    "fonte",
    "commit",
    "data_versao",
    "alteracoes",
    "arquivos",
  ])("origem sem %s derruba a geração, nomeando a origem e o campo", (campo) => {
    const pasta = copiaDosRegistros();
    const alvo = "perseus-greeklit-josefo";
    const reg = parse(readFileSync(join(pasta, "acervo-origens.yaml"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    delete reg[alvo]?.[campo];
    writeFileSync(join(pasta, "acervo-origens.yaml"), stringify(reg));
    const erro = (() => {
      try {
        montarCreditos({ diretorio: pasta });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(erro).toBeInstanceOf(Error);
    expect(erro?.message).toContain(`"${alvo}"`);
    expect(erro?.message).toContain(campo);
    // O erro nomeia o campo, nunca o conteúdo do registro.
    expect(erro?.message).not.toContain("Whiston");
  });

  it("Fonte publicada que nenhuma origem do registro alimenta derruba a geração, nomeando a Fonte", () => {
    const pasta = copiaDosRegistros();
    const fontesNovas = copiaDasFontes();
    cpSync(join(fontesNovas, "evangelho-de-tome.yaml"), join(fontesNovas, "obra-orfa.yaml"));
    const texto = readFileSync(join(fontesNovas, "obra-orfa.yaml"), "utf8").replace(
      /^slug: .*$/m,
      "slug: obra-orfa",
    );
    writeFileSync(join(fontesNovas, "obra-orfa.yaml"), texto);
    const erro = (() => {
      try {
        montarCreditos({ diretorio: pasta, diretorioFontes: fontesNovas });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(erro).toBeInstanceOf(Error);
    expect(erro?.message).toContain('"obra-orfa"');
  });

  it("Fonte alimentada por duas origens derruba a geração, nomeando as duas", () => {
    const pasta = copiaDosRegistros();
    const reg = parse(readFileSync(join(pasta, "acervo-origens.yaml"), "utf8")) as Record<
      string,
      Origem
    >;
    (reg["ccel-anf08"] as Origem).arquivos.push({ slug: "josefo-antiguidades" });
    writeFileSync(join(pasta, "acervo-origens.yaml"), stringify(reg));
    const erro = (() => {
      try {
        montarCreditos({ diretorio: pasta });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(erro).toBeInstanceOf(Error);
    expect(erro?.message).toContain("josefo-antiguidades");
    expect(erro?.message).toContain("duas origens");
  });

  it("Fonte publicada sem licença derruba a geração (a atribuição sairia cortada)", () => {
    const pasta = copiaDosRegistros();
    const fontesNovas = copiaDasFontes();
    const texto = readFileSync(join(fontesNovas, "evangelho-de-tome.yaml"), "utf8")
      .replace(/^slug: .*$/m, "slug: obra-sem-licenca")
      .replace(/^licenca: .*$/m, "");
    writeFileSync(join(fontesNovas, "obra-sem-licenca.yaml"), texto);
    expect(() => montarCreditos({ diretorio: pasta, diretorioFontes: fontesNovas })).toThrow(
      /licença|licenca/,
    );
  });
});
