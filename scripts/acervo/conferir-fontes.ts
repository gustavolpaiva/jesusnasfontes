// `pnpm acervo:conferir [<slug>…]` — o conferidor dos YAML de Fonte do Acervo (plano 09, D-06, D-07, D-18).
// Lê SÓ o YAML, o derivado versionado e o lock (nunca o bruto, nunca rede) e reprova: seção do derivado sem
// resumo em português, resumo repetido, palavras-chave fora de 3 a 10, resumo fora de 40 a 700 caracteres,
// resumo com "<" ou "http", licença fora do vocabulário fechado, tradutor diferente do verificado na origem e
// seção acima do teto sem exceção registrada. Uma linha por Fonte: `OK <slug>` ou `REPROVADO <slug>: <regra>`.
// Sai 1 se alguma reprovar; 2 se uma Fonte `publicada: true` está sem derivado no lock.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { licencaValida } from "../../src/modules/acervo/licenca-exibida";
import {
  type Derivado,
  type FonteYaml,
  interpretarFonteYaml,
} from "../../src/modules/acervo/schemas";
import { acharArquivoDoDerivado, CAMINHO_ORIGENS, lerOrigens } from "../ingest/acervo-origens";
import { PASTA_FONTES, TETO_SECAO_CARACTERES } from "./carregar";
import {
  CAMINHO_LOCK,
  type LockDerivados,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "./derivados";

export const MIN_RESUMO_CARACTERES = 40;
export const MAX_RESUMO_CARACTERES = 700;
export const MIN_PALAVRAS_CHAVE = 3;
export const MAX_PALAVRAS_CHAVE = 10;

const numero = (v: number) => v.toLocaleString("pt-BR");
const escapeDeRegex = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// O que pode sobrar no campo `tradutor` além dos nomes verificados na origem: só conectivos e o papel de cada
// nome ("com revisão de"). Qualquer outra palavra é nome que a origem não verificou.
const CONECTIVOS_DO_TRADUTOR = new Set([
  "e",
  "com",
  "de",
  "por",
  "rev",
  "revisão",
  "revisada",
  "corrigida",
  "tradução",
  "and",
  "und",
  "with",
]);

/** Casa o nome esperado no texto do YAML tolerando espaço e quebra entre os caracteres ("F. C. T." ~ "F.C.T."). */
function casarSemEspaco(texto: string, nome: string): { inicio: number; fim: number } | null {
  const padrao = new RegExp(
    [...nome]
      .filter((c) => !/\s/.test(c))
      .map(escapeDeRegex)
      .join("\\s*"),
  );
  const m = padrao.exec(texto);
  return m ? { inicio: m.index, fim: m.index + m[0].length } : null;
}

/**
 * O `tradutor` do YAML confere com os nomes lidos e verificados no cabeçalho da origem
 * (`verificador.tradutores` do registro): todo nome esperado aparece, e fora deles só conectivos. O nome que a
 * origem não verificou (o caso Harmon no Perseus) reprova.
 */
export function tradutorConfere(tradutor: string, esperados: readonly string[]): boolean {
  let resto = tradutor;
  for (const nome of esperados) {
    const achado = casarSemEspaco(resto, nome);
    if (!achado) return false;
    resto = `${resto.slice(0, achado.inicio)} ${resto.slice(achado.fim)}`;
  }
  const palavras = resto.split(/[^A-Za-zÀ-ÿ]+/).filter(Boolean);
  return palavras.every((p) => CONECTIVOS_DO_TRADUTOR.has(p.toLocaleLowerCase("pt-BR")));
}

export type ContextoDaConferencia = {
  /** Nomes lidos e verificados na origem (`verificador.tradutores` do registro). */
  tradutores: readonly string[];
  /** O derivado versionado da Fonte; `null` quando não há (Fonte não publicada sem derivado). */
  derivado: Derivado | null;
};

/** As regras sobre uma Fonte já interpretada. Cada falha vem como `<regra>: <detalhe>`. */
export function conferirFonte(fonte: FonteYaml, contexto: ContextoDaConferencia): string[] {
  const falhas: string[] = [];
  if (fonte.licenca && !licencaValida(fonte.licenca))
    falhas.push(
      `licenca: o código "${fonte.licenca}" está fora do vocabulário fechado (ver licenca-exibida.ts)`,
    );
  if (contexto.tradutores.length > 0) {
    if (!fonte.tradutor) {
      falhas.push(`tradutor: ausente no YAML; a origem verifica ${contexto.tradutores.join(", ")}`);
    } else if (!tradutorConfere(fonte.tradutor, contexto.tradutores)) {
      falhas.push(
        `tradutor: "${fonte.tradutor}" difere do verificado na origem (${contexto.tradutores.join(", ")})`,
      );
    }
  }
  const { derivado } = contexto;
  if (!derivado) return falhas;

  const porSlug = new Map(fonte.secoes.map((s) => [s.slug, s]));
  const teto = fonte.secao_max_caracteres?.caracteres ?? TETO_SECAO_CARACTERES;
  for (const s of derivado.secoes) {
    const y = porSlug.get(s.slug);
    const resumo = y?.resumo_pt?.trim();
    if (!resumo) {
      falhas.push(`secao-sem-resumo: a seção ${s.slug} do derivado não tem resumo_pt no YAML`);
      continue;
    }
    if (resumo.length < MIN_RESUMO_CARACTERES)
      falhas.push(
        `resumo-tamanho: a seção ${s.slug} tem resumo com menos de ${MIN_RESUMO_CARACTERES} caracteres (${resumo.length})`,
      );
    else if (resumo.length > MAX_RESUMO_CARACTERES)
      falhas.push(
        `resumo-tamanho: a seção ${s.slug} tem resumo com mais de ${MAX_RESUMO_CARACTERES} caracteres (${resumo.length})`,
      );
    if (resumo.includes("<") || resumo.includes("http"))
      falhas.push(`resumo-conteudo: o resumo da seção ${s.slug} contém "<" ou "http"`);
    const total = s.paragrafos.reduce((n, p) => n + p.texto.length, 0);
    if (total > teto)
      falhas.push(
        `teto-de-secao: a seção ${s.slug} tem ${numero(total)} caracteres, acima do teto de ${numero(teto)}, sem exceção registrada em secao_max_caracteres`,
      );
    const palavras = y?.palavras_chave_pt ?? [];
    if (palavras.length < MIN_PALAVRAS_CHAVE)
      falhas.push(
        `palavras-chave: a seção ${s.slug} tem menos de ${MIN_PALAVRAS_CHAVE} termos (${palavras.length})`,
      );
    else if (palavras.length > MAX_PALAVRAS_CHAVE)
      falhas.push(
        `palavras-chave: a seção ${s.slug} tem mais de ${MAX_PALAVRAS_CHAVE} termos (${palavras.length})`,
      );
  }

  const resumoPorSecao = new Map<string, string>();
  for (const s of derivado.secoes) {
    const resumo = porSlug.get(s.slug)?.resumo_pt?.trim();
    if (!resumo) continue;
    const primeira = resumoPorSecao.get(resumo);
    if (primeira !== undefined)
      falhas.push(`resumo-duplicado: as seções ${primeira} e ${s.slug} têm o mesmo resumo`);
    else resumoPorSecao.set(resumo, s.slug);
  }
  for (const s of fonte.secoes)
    if (!derivado.secoes.some((d) => d.slug === s.slug))
      falhas.push(`secao-desconhecida: a seção ${s.slug} do YAML não existe no derivado`);

  return falhas;
}

/** Interpreta o YAML e aplica as regras; erro de contrato vira a falha `contrato`. */
export function conferirYaml(
  conteudo: string,
  rotulo: string,
  contexto: ContextoDaConferencia,
): string[] {
  try {
    return conferirFonte(interpretarFonteYaml(conteudo, rotulo), contexto);
  } catch (erro) {
    return [`contrato: ${(erro as Error).message}`];
  }
}

// ───────────────────────── comando: pnpm acervo:conferir ─────────────────────────

export type OpcoesConferir = {
  fontes: string;
  derivados: string;
  lock: string;
  origens: string;
};
export type ResultadoConferir = { linhas: string[]; codigo: 0 | 1 | 2 };

/** 0 limpo; 1 quando alguma regra reprovar; 2 quando uma Fonte publicada está sem derivado. */
export function codigoDeSaidaDaConferencia(r: ResultadoConferir): 0 | 1 | 2 {
  return r.codigo;
}

/**
 * Confere cada YAML da pasta (ou só os slugs pedidos): contrato, lock, origem no registro, tradutor e as regras
 * de resumo sobre o derivado versionado de cada Fonte.
 */
export function conferirFontes(
  slugs: readonly string[] | undefined,
  opcoes: OpcoesConferir,
): ResultadoConferir {
  const linhas: string[] = [];
  let reprovou = false;
  let semDerivado = false;

  const origens = lerOrigens(opcoes.origens);
  let lock: LockDerivados;
  try {
    lock = lerLock(opcoes.lock);
    verificarDerivados(opcoes.derivados, lock);
  } catch (erro) {
    return { linhas: [`REPROVADO lock: ${(erro as Error).message}`], codigo: 1 };
  }

  const nomes = readdirSync(opcoes.fontes)
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  const filtro = slugs === undefined || slugs.length === 0 ? null : new Set(slugs);
  if (filtro) {
    const existentes = new Set(nomes.map((n) => n.slice(0, -".yaml".length)));
    for (const s of filtro)
      if (!existentes.has(s)) {
        linhas.push(`REPROVADO ${s}: não há YAML desta Fonte`);
        reprovou = true;
      }
  }

  for (const nome of nomes) {
    const slug = nome.slice(0, -".yaml".length);
    if (filtro && !filtro.has(slug)) continue;
    let fonte: FonteYaml;
    try {
      fonte = interpretarFonteYaml(readFileSync(path.join(opcoes.fontes, nome), "utf8"), nome);
    } catch (erro) {
      linhas.push(`REPROVADO ${slug}: contrato: ${(erro as Error).message}`);
      reprovou = true;
      continue;
    }
    const achado = acharArquivoDoDerivado(origens, slug);
    if (!achado) {
      linhas.push(`REPROVADO ${slug}: origem: nenhuma origem do registro alimenta esta Fonte`);
      reprovou = true;
      continue;
    }
    let derivado: Derivado | null = null;
    if (lock.derivados[slug]) {
      try {
        derivado = lerDerivado(opcoes.derivados, lock, slug);
      } catch (erro) {
        linhas.push(`REPROVADO ${slug}: ${(erro as Error).message}`);
        reprovou = true;
        continue;
      }
    } else if (fonte.publicada) {
      linhas.push(
        `REPROVADO ${slug}: derivado-ausente: a Fonte está publicada e não há derivado no lock`,
      );
      semDerivado = true;
      continue;
    }
    const falhas = conferirFonte(fonte, {
      tradutores: achado.origem.verificador.tradutores,
      derivado,
    });
    if (falhas.length > 0) {
      for (const f of falhas) linhas.push(`REPROVADO ${slug}: ${f}`);
      reprovou = true;
    } else {
      linhas.push(`OK ${slug}`);
    }
  }
  return { linhas, codigo: semDerivado ? 2 : reprovou ? 1 : 0 };
}

/**
 * Separa as flags (cada uma com o seu valor) dos argumentos posicionais. O valor de uma flag nunca vira
 * slug: antes da correção, `--fontes <pasta> <slug>` tratava `<pasta>` como slug e reprovava de mentira.
 */
export function lerOpcoes(argumentos: string[]): { slugs: string[]; opcoes: OpcoesConferir } {
  const valores = new Map<string, string>();
  const slugs: string[] = [];
  for (let i = 0; i < argumentos.length; i++) {
    const a = argumentos[i];
    if (a.startsWith("--")) {
      const v = argumentos[i + 1];
      if (!v)
        throw new Error(
          "Uso: acervo:conferir [--fontes <pasta>] [--derivados <pasta>] [--lock <arquivo>]",
        );
      valores.set(a, v);
      i++;
    } else {
      slugs.push(a);
    }
  }
  const valor = (flag: string, padrao: string): string => path.resolve(valores.get(flag) ?? padrao);
  return {
    slugs,
    opcoes: {
      fontes: valor("--fontes", PASTA_FONTES),
      derivados: valor("--derivados", PASTA_DERIVADOS),
      lock: valor("--lock", CAMINHO_LOCK),
      origens: valor("--origens", CAMINHO_ORIGENS),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { slugs, opcoes } = lerOpcoes(process.argv.slice(2));
    const r = conferirFontes(slugs, opcoes);
    for (const l of r.linhas) console.log(l);
    process.exit(codigoDeSaidaDaConferencia(r));
  } catch (erro) {
    console.error((erro as Error).message);
    process.exit(1);
  }
}
