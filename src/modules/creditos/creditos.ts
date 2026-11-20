import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// A página de créditos (ACER-12) é gerada dos registros, nunca escrita à mão: um conjunto novo em
// `data/datasets.yaml`, uma fonte nova em `data/tipografia.yaml` ou uma entrada nova em
// `data/creditos-proprios.yaml` aparece na página sem mexer em código. Um registro com campo faltando
// derruba a geração (o build), em vez de sair com uma atribuição cortada.
//
// Sem `server-only`: o teste de unidade também lê os registros por aqui.

export type EntradaDeCredito = {
  nome: string;
  autores: string;
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
};

const texto = z.string().trim().min(1);

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

function lerYaml(diretorio: string, arquivo: string): unknown {
  return parse(readFileSync(join(diretorio, arquivo), "utf8"));
}

const listaEmPortugues = new Intl.ListFormat("pt-BR", { style: "long", type: "conjunction" });

// "2025-01-12" → "12/01/2025". O registro guarda a data em ISO; a página mostra em formato brasileiro.
function dataBrasileira(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : iso;
}

// Ordem na página: texto bíblico, conteúdo, código, fontes (a do contrato de copy). Dentro de cada
// registro, a ordem do arquivo.
export function montarCreditos(opcoes: { diretorio?: string } = {}): EntradaDeCredito[] {
  const diretorio = opcoes.diretorio ?? join(process.cwd(), "data");
  const datasets = esquemaDatasets.parse(lerYaml(diretorio, "datasets.yaml"));
  const tipografia = esquemaTipografia.parse(lerYaml(diretorio, "tipografia.yaml"));
  const proprios = esquemaProprios.parse(lerYaml(diretorio, "creditos-proprios.yaml"));
  const urlDaLicenca = (nome: string) => proprios.licencas[nome] ?? null;

  const texto: EntradaDeCredito[] = Object.values(datasets).map((d) => ({
    nome: d.nome,
    autores: listaEmPortugues.format(d.autores),
    licenca: d.licenca,
    urlLicenca: d.url_licenca,
    notaDaLicenca: null,
    versao: `${d.edicao_exibida ? `Edição ${d.edicao_exibida}, ` : ""}commit ${d.commit.slice(0, 7)}, de ${dataBrasileira(d.data_versao)}`,
    urlOrigem: `${d.fonte}/tree/${d.commit}`,
    alteracoes: d.alteracoes,
    creditoLiteral: d.credito_literal ?? null,
  }));

  const nossos: EntradaDeCredito[] = proprios.entradas.map((e) => ({
    nome: e.nome,
    autores: listaEmPortugues.format(e.autores),
    licenca: e.licenca,
    urlLicenca: urlDaLicenca(e.licenca),
    notaDaLicenca: e.nota_licenca ?? null,
    versao: e.versao,
    urlOrigem: e.repositorio ?? null,
    alteracoes: e.alteracoes,
    creditoLiteral: null,
  }));

  const fontes: EntradaDeCredito[] = tipografia.fontes.map((f) => ({
    nome: f.familia,
    autores: f.autores,
    licenca: f.licenca,
    urlLicenca: urlDaLicenca(f.licenca),
    notaDaLicenca: null,
    versao: `commit ${tipografia.commit.slice(0, 7)} do repositório de fontes`,
    urlOrigem: `${tipografia.repositorio}/tree/${tipografia.commit}`,
    alteracoes: f.alteracoes,
    creditoLiteral: null,
  }));

  // O conteúdo e o código ficam entre o texto bíblico e as fontes, na ordem do contrato.
  return [...texto, ...nossos, ...fontes];
}
