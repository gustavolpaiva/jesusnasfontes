import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { textoDaLicenca } from "@/modules/acervo/licenca-exibida";
import { type FonteYaml, interpretarFonteYaml } from "@/modules/acervo/schemas";

// A página de créditos (ACER-12) é gerada dos registros, nunca escrita à mão: um conjunto novo em
// `data/datasets.yaml`, uma fonte nova em `data/tipografia.yaml`, uma entrada nova em
// `data/creditos-proprios.yaml` ou uma origem nova em `data/acervo-origens.yaml` aparece na página sem
// mexer em código. Um registro com campo faltando derruba a geração (o build), em vez de sair com uma
// atribuição cortada.
//
// Sem `server-only`: o teste de unidade também lê os registros por aqui.

export type FonteCreditada = { slug: string; titulo: string };

export type EntradaDeCredito = {
  nome: string;
  /** Uma linha por autor; a página mostra lista quando há mais de uma. */
  autores: string[];
  licenca: string;
  urlLicenca: string | null;
  // Frase curta que acompanha a licença quando ela não tem endereço (ex.: onde está o texto da MIT).
  notaDaLicenca: string | null;
  versao: string;
  // Link da origem (repositório do texto, das fontes ou do código), quando o registro traz.
  urlOrigem: string | null;
  alteracoes: string;
  // Texto de atribuição literal da fonte, quando ela exige (Bíblia Livre). Idêntico ao do registro.
  creditoLiteral: string | null;
  /** No Acervo: as Fontes publicadas que vêm desta origem, com o endereço da página de cada uma. Fora dele, vazio. */
  usadoEm: FonteCreditada[];
  /** `geral` são as entradas da Fase 1; `acervo`, as do registro de origens (a seção "Textos do Acervo"). */
  grupo: "geral" | "acervo";
};

const texto = z.string().trim().min(1);
const https = z.string().regex(/^https:\/\/\S+$/, "deve começar por https:// e não ter espaços");

const esquemaDatasets = z.record(
  z.string(),
  z.object({
    nome: texto,
    autores: z.array(texto).min(1),
    licenca: texto,
    url_licenca: texto,
    fonte: texto,
    commit: texto,
    data_versao: texto,
    edicao_exibida: texto.optional(),
    credito_literal: texto.optional(),
    alteracoes: texto,
  }),
);

const esquemaTipografia = z.object({
  commit: texto,
  repositorio: texto,
  fontes: z
    .array(
      z.object({
        familia: texto,
        autores: texto,
        licenca: texto,
        alteracoes: texto,
      }),
    )
    .min(1),
});

const esquemaProprios = z.object({
  licencas: z.record(z.string(), texto),
  entradas: z
    .array(
      z.object({
        nome: texto,
        autores: z.array(texto).min(1),
        licenca: texto,
        nota_licenca: texto.optional(),
        versao: texto,
        alteracoes: texto,
        repositorio: texto.optional(),
      }),
    )
    .min(1),
});

// Do registro de origens do Acervo só entra aqui o que a atribuição precisa. Os campos do pipeline
// (formato, verificador, esperado…) ficam de fora e não são lidos por esta página: `acervo-origens.yaml`
// é lido por ele mesmo, sem importar o módulo de desenvolvedor. `arquivos` é o que liga a origem às Fontes.
const esquemaOrigem = z.object({
  nome: texto,
  autores: z.array(texto).min(1),
  licenca: texto,
  url_licenca: https,
  fonte: https,
  commit: texto,
  data_versao: texto,
  alteracoes: texto,
  arquivos: z.array(z.object({ slug: texto }).strip()).min(1),
});
type OrigemAcervo = z.infer<typeof esquemaOrigem>;

function lerYaml(diretorio: string, arquivo: string): unknown {
  return parse(readFileSync(join(diretorio, arquivo), "utf8"));
}

const listaEmPortugues = new Intl.ListFormat("pt-BR", { style: "long", type: "conjunction" });

// "2025-01-12" → "12/01/2025". O registro guarda a data em ISO; a página mostra em formato brasileiro.
function dataBrasileira(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : iso;
}

// ───────────────────────── Textos do Acervo ─────────────────────────

/**
 * Lê o registro de origens. Origem fora do contrato derruba a geração e o erro nomeia a origem e o campo
 * (nunca o conteúdo).
 */
function lerOrigens(diretorio: string): Record<string, OrigemAcervo> {
  let bruto: unknown;
  try {
    bruto = lerYaml(diretorio, "acervo-origens.yaml");
  } catch {
    throw new Error("acervo-origens.yaml: registro de origens ausente ou ilegível");
  }
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto))
    throw new Error("acervo-origens.yaml: a raiz tem de ser um registro, uma origem por chave");
  const saida: Record<string, OrigemAcervo> = {};
  for (const [id, valor] of Object.entries(bruto)) {
    const r = esquemaOrigem.safeParse(valor);
    if (!r.success) {
      const campos = [
        ...new Set(r.error.issues.map((i) => i.path.map(String).join(".") || "(raiz)")),
      ];
      throw new Error(`acervo-origens.yaml: origem "${id}" fora do contrato: ${campos.join(", ")}`);
    }
    saida[id] = r.data;
  }
  return saida;
}

/** Os YAMLs de Fonte (o contrato da Fonte, o mesmo da carga), na ordem alfabética dos arquivos. */
function lerFontes(diretorio: string): FonteYaml[] {
  let nomes: string[];
  try {
    nomes = readdirSync(diretorio)
      .filter((n) => n.endsWith(".yaml"))
      .sort();
  } catch {
    throw new Error("content/acervo/fontes: pasta das Fontes ausente ou ilegível");
  }
  return nomes.map((nome) =>
    interpretarFonteYaml(readFileSync(join(diretorio, nome), "utf8"), nome),
  );
}

// O identificador git de um commit (40 hexadecimais). As origens que não versionam guardam aqui a
// impressão sha256 do arquivo bruto (64 hexadecimais).
const COMMIT_GIT = /^[0-9a-f]{40}$/;
const IMPRESSAO_SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORIO_GITHUB = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/;

/** "commit dacb049, de 13/11/2026" quando a origem versiona; "sha256 2e18deb94f36 do arquivo, de …" quando não. */
function versaoDaOrigem(o: OrigemAcervo): string {
  const data = dataBrasileira(o.data_versao);
  if (COMMIT_GIT.test(o.commit)) return `commit ${o.commit.slice(0, 7)}, de ${data}`;
  if (IMPRESSAO_SHA256.test(o.commit))
    return `sha256 ${o.commit.slice(0, 12)} do arquivo, de ${data}`;
  return `${o.commit}, de ${data}`;
}

/** O endereço do registro; só repositório do GitHub com commit fixado ganha o sufixo de árvore. */
function enderecoDaOrigem(o: OrigemAcervo): string {
  return REPOSITORIO_GITHUB.test(o.fonte) && COMMIT_GIT.test(o.commit)
    ? `${o.fonte.replace(/\/$/, "")}/tree/${o.commit}`
    : o.fonte;
}

const licencaDe = (f: FonteYaml): string => {
  if (!f.licenca)
    throw new Error(`Fonte "${f.slug}": texto integral sem licença; a atribuição sairia cortada`);
  return f.licenca;
};

/**
 * O tradutor de cada obra publicada desta origem, numa linha só, quando o registro só nomeia o editor e a
 * biblioteca. Quem o registro já nomeia (pelo nome inicial do tradutor) não é repetido. Sem tradutor
 * declarado na edição, ninguém é inventado. Sem ponto final: os nomes podem terminar em abreviatura
 * ("D.D.", "Esq.") e as linhas de autor do registro também não o trazem.
 */
function tradutoresNaoNomeados(autores: readonly string[], fontes: readonly FonteYaml[]): string[] {
  const nomes = autores.join("\n");
  const traducoes: string[] = [];
  for (const f of fontes) {
    const tradutor = f.tradutor?.trim();
    if (!tradutor) continue;
    const nomeInicial = tradutor.split(/,| e | com /)[0]?.trim() ?? tradutor;
    if (nomes.includes(nomeInicial)) continue;
    if (!traducoes.includes(tradutor)) traducoes.push(tradutor);
  }
  return traducoes.length === 0 ? [] : [`Tradução de ${traducoes.join("; ")}`];
}

/**
 * Uma entrada por origem de que o site usa ao menos uma Fonte publicada. "Usado em" são essas Fontes, com o
 * link de cada página. Origem sem Fonte publicada não ganha entrada (o site não usa texto dela). Toda Fonte
 * publicada tem de ser alimentada por exatamente uma origem do registro: se não é, a atribuição está
 * incompleta e a geração para, nomeando a Fonte.
 */
function entradasDoAcervo(
  origens: Record<string, OrigemAcervo>,
  fontes: readonly FonteYaml[],
  publicadasNoBanco: ReadonlySet<string> | undefined,
): EntradaDeCredito[] {
  const porSlug = new Map(fontes.map((f) => [f.slug, f]));
  // O que vale como "publicada": o BANCO, quando a página o traz (o painel despublica uma Fonte sem passar pelo YAML, e o
  // link de "Usado em" para uma Fonte despublicada vira 404); sem o banco (o build, o teste de unidade), o YAML.
  const estaPublicada = (f: FonteYaml): boolean =>
    publicadasNoBanco ? publicadasNoBanco.has(f.slug) : f.publicada === true;
  const ehUsada = (f: FonteYaml | undefined): f is FonteYaml =>
    f !== undefined && estaPublicada(f) && f.tipo_texto === "integral";
  // A mesma ordem alfabética em português da lista do Acervo.
  const porTitulo = (a: FonteYaml, b: FonteYaml) => a.titulo.localeCompare(b.titulo, "pt-BR");

  const daOrigemDe = new Map<string, string>();
  const entradas: EntradaDeCredito[] = [];
  for (const [id, o] of Object.entries(origens)) {
    const usadas = o.arquivos.flatMap((a) => porSlug.get(a.slug) ?? []).filter(ehUsada);
    for (const f of usadas) {
      const outra = daOrigemDe.get(f.slug);
      if (outra !== undefined && outra !== id)
        throw new Error(
          `acervo-origens.yaml: a Fonte "${f.slug}" é alimentada por duas origens ("${outra}" e "${id}")`,
        );
      daOrigemDe.set(f.slug, id);
    }
    // Nenhuma Fonte publicada desta origem: nada dela está no site, e crédito sem "Usado em" seria atribuição
    // de texto que não se usa.
    if (usadas.length === 0) continue;
    usadas.sort(porTitulo);
    // A licença pelo vocabulário fechado do Acervo (o mesmo texto da página da Fonte). Edição digital e
    // tradução aparecem separadas quando a licença da edição não é a da tradução.
    const licencas = [
      ...new Set(
        usadas.map((f) =>
          textoDaLicenca(licencaDe(f), { tradutor: f.tradutor, ano: f.traducao_ano }),
        ),
      ),
    ];
    entradas.push({
      nome: o.nome,
      autores: [...o.autores, ...tradutoresNaoNomeados(o.autores, usadas)],
      licenca: licencas.join(" "),
      urlLicenca: o.url_licenca,
      notaDaLicenca: null,
      versao: versaoDaOrigem(o),
      urlOrigem: enderecoDaOrigem(o),
      alteracoes: o.alteracoes,
      creditoLiteral: null,
      usadoEm: usadas.map((f) => ({ slug: f.slug, titulo: f.titulo })),
      grupo: "acervo",
    });
  }

  for (const f of fontes) {
    // Em tempo de execução (o banco decide) uma Fonte publicada sem origem não derruba a página: é inconsistência do
    // painel, e a atribuição dela fica a cargo do registro. No build (o YAML decide) ela derruba, como sempre.
    if (publicadasNoBanco === undefined && ehUsada(f) && !daOrigemDe.has(f.slug))
      throw new Error(
        `acervo-origens.yaml: a Fonte publicada "${f.slug}" não é alimentada por nenhuma origem do registro`,
      );
  }
  return entradas;
}

// Ordem na página: texto bíblico, conteúdo, código, fontes (a do contrato de copy) e, por último, os textos
// do Acervo. Dentro de cada registro, a ordem do arquivo.
export type OpcoesDeCreditos = {
  diretorio?: string;
  diretorioFontes?: string;
};

/** Os registros lidos e validados UMA vez; `montar` aplica, por requisição, o que o banco diz estar publicado. */
export type CreditosPreparados = {
  montar: (publicadasNoBanco?: ReadonlySet<string>) => EntradaDeCredito[];
};

export function montarCreditos(
  opcoes: OpcoesDeCreditos & { publicadasNoBanco?: ReadonlySet<string> } = {},
): EntradaDeCredito[] {
  return prepararCreditos(opcoes).montar(opcoes.publicadasNoBanco);
}

export function prepararCreditos(opcoes: OpcoesDeCreditos = {}): CreditosPreparados {
  const diretorio = opcoes.diretorio ?? join(process.cwd(), "data");
  const diretorioFontes =
    opcoes.diretorioFontes ?? join(process.cwd(), "content", "acervo", "fontes");
  const datasets = esquemaDatasets.parse(lerYaml(diretorio, "datasets.yaml"));
  const tipografia = esquemaTipografia.parse(lerYaml(diretorio, "tipografia.yaml"));
  const proprios = esquemaProprios.parse(lerYaml(diretorio, "creditos-proprios.yaml"));
  const urlDaLicenca = (nome: string) => proprios.licencas[nome] ?? null;

  const texto: EntradaDeCredito[] = Object.values(datasets).map((d) => ({
    nome: d.nome,
    autores: [listaEmPortugues.format(d.autores)],
    licenca: d.licenca,
    urlLicenca: d.url_licenca,
    notaDaLicenca: null,
    versao: `${d.edicao_exibida ? `Edição ${d.edicao_exibida}, ` : ""}commit ${d.commit.slice(0, 7)}, de ${dataBrasileira(d.data_versao)}`,
    urlOrigem: `${d.fonte}/tree/${d.commit}`,
    alteracoes: d.alteracoes,
    creditoLiteral: d.credito_literal ?? null,
    usadoEm: [],
    grupo: "geral",
  }));

  const nossos: EntradaDeCredito[] = proprios.entradas.map((e) => ({
    nome: e.nome,
    autores: [listaEmPortugues.format(e.autores)],
    licenca: e.licenca,
    urlLicenca: urlDaLicenca(e.licenca),
    notaDaLicenca: e.nota_licenca ?? null,
    versao: e.versao,
    urlOrigem: e.repositorio ?? null,
    alteracoes: e.alteracoes,
    creditoLiteral: null,
    usadoEm: [],
    grupo: "geral",
  }));

  const fontes: EntradaDeCredito[] = tipografia.fontes.map((f) => ({
    nome: f.familia,
    autores: [f.autores],
    licenca: f.licenca,
    urlLicenca: urlDaLicenca(f.licenca),
    notaDaLicenca: null,
    versao: `commit ${tipografia.commit.slice(0, 7)} do repositório de fontes`,
    urlOrigem: `${tipografia.repositorio}/tree/${tipografia.commit}`,
    alteracoes: f.alteracoes,
    creditoLiteral: null,
    usadoEm: [],
    grupo: "geral",
  }));

  const origens = lerOrigens(diretorio);
  const fontesYaml = lerFontes(diretorioFontes);
  // O conteúdo e o código ficam entre o texto bíblico e as fontes, na ordem do contrato.
  const gerais = [...texto, ...nossos, ...fontes];
  const montar = (publicadasNoBanco?: ReadonlySet<string>): EntradaDeCredito[] => [
    ...gerais,
    ...entradasDoAcervo(origens, fontesYaml, publicadasNoBanco),
  ];
  // Valida já no carregamento (o build): registro fora do contrato derruba aqui, não na primeira requisição.
  montar();
  return { montar };
}
