// Leitura da PASTA de propostas de Grau e de Citação (plano 02-20), compartilhada pelo validador e pela carga.
// A pasta é SEMPRE parâmetro e fica fora do produto público (D-17): as propostas moram no planejamento privado.
// Só lê arquivo; nunca abre conexão nem rede. Os erros nomeiam arquivo, posição e regra, nunca o texto proposto.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ErroContrato,
  type ErroDeProposta,
  interpretarPropostasYaml,
  type PropostaYaml,
} from "../../src/modules/acervo/schemas";

export type PropostaLida = PropostaYaml & { arquivo: string };
export type ErroLido = ErroDeProposta & { arquivo: string };

export function nomesDeProposta(pasta: string): string[] {
  let nomes: string[];
  try {
    nomes = readdirSync(pasta)
      .filter((nome) => nome.endsWith(".yaml"))
      .sort();
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT")
      throw new ErroContrato("a pasta de propostas não existe");
    throw erro;
  }
  if (nomes.length === 0) throw new ErroContrato("a pasta de propostas não tem nenhum .yaml");
  return nomes;
}

/** Todas as propostas da pasta (um ou mais `.yaml`), na ordem dos arquivos, com os erros de contrato de cada entrada. */
export function lerPastaDePropostas(pasta: string): {
  propostas: PropostaLida[];
  erros: ErroLido[];
} {
  const propostas: PropostaLida[] = [];
  const erros: ErroLido[] = [];
  for (const arquivo of nomesDeProposta(pasta)) {
    const lido = interpretarPropostasYaml(readFileSync(path.join(pasta, arquivo), "utf8"), arquivo);
    for (const p of lido.propostas) propostas.push({ ...p, arquivo });
    for (const e of lido.erros) erros.push({ ...e, arquivo });
  }
  return { propostas, erros };
}

/** Descreve um erro de contrato de entrada sem nenhum texto proposto. */
export function descreverErro(e: ErroLido): string {
  const quem = e.afirmacao ?? `entrada ${e.indice}`;
  return `${quem} (${e.arquivo}): ${e.mensagem}`;
}
