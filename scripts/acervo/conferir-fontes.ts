// `pnpm acervo:conferir [<slug>…]` — o conferidor dos YAML de Fonte do Acervo (plano 09, D-06, D-07, D-18).
// Lê SÓ o YAML, o derivado versionado e o lock (nunca o bruto, nunca rede) e reprova: seção do derivado sem
// resumo em português, resumo repetido, palavras-chave fora de 3 a 10, resumo fora de 40 a 700 caracteres,
// resumo com "<" ou "http", licença fora do vocabulário fechado, tradutor diferente do verificado na origem,
// tradutor que é EDITOR do volume (lista `verificador.editores` do registro), tradutor sem evidência
// (`evidencia_tradutor` do arquivo no registro) e seção acima do teto sem exceção registrada. Uma linha por Fonte: `OK <slug>` ou `REPROVADO <slug>: <regra>`.
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

// ───────────────────────── nomes: UMA normalização para todo lado de toda comparação ─────────────────────────
// O valor do YAML, o nome esperado, a frase da evidência e os conectivos passam todos por `palavrasDe`: sem acento,
// sem caixa, só letras. Comparar um lado normalizado com outro cru reprovava "Tradução de S. Thelwall" por causa do
// "ç" e "De Rossi, Giovanni Battista" por causa do sobrenome composto.

const semAcento = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
/** Palavras de um texto, sem acento nem caixa, só letras. */
const palavrasDe = (t: string): string[] =>
  semAcento(t)
    .split(/[^a-z]+/)
    .filter(Boolean);
const compactar = (t: string) => t.split(/\s+/).filter(Boolean).join(" ");

/** Partículas de sobrenome: fazem parte do sobrenome ("De Rossi", "von Harnack") e nunca são outro nome. */
const PARTICULAS = new Set(
  "de da do das dos di del della delle degli du des von van der den ten ter la le el al bin ibn zu y".split(
    " ",
  ),
);

// O que pode sobrar no campo `tradutor` além dos nomes esperados: só conectivos, títulos e o papel de cada nome
// ("com revisão de", "tradução de", "traduzido por", "tr."). Qualquer outra palavra é nome que a origem não nomeou.
const CONECTIVOS_DO_TRADUTOR = new Set(
  [
    "e",
    "com",
    "de",
    "por",
    "pelo",
    "pela",
    "rev",
    "revisão",
    "revisada",
    "corrigida",
    "tradução",
    "traduzido",
    "traduzida",
    "tradutor",
    "tradutora",
    "tr",
    "trad",
    "translated",
    "translator",
    "by",
    "and",
    "und",
    "with",
    "dr",
    "sir",
    "prof",
    "ph",
  ].flatMap(palavrasDe),
);
const SOBRA_PERMITIDA = (p: string, nomes: ReadonlySet<string>) =>
  p.length === 1 || CONECTIVOS_DO_TRADUTOR.has(p) || PARTICULAS.has(p) || nomes.has(p);

/** `sequencia` aparece em `palavras` como palavras seguidas, na mesma ordem. Devolve a posição, ou -1. */
function acharSequencia(palavras: readonly string[], sequencia: readonly string[]): number {
  if (sequencia.length === 0) return -1;
  for (let i = 0; i + sequencia.length <= palavras.length; i++)
    if (sequencia.every((w, k) => palavras[i + k] === w)) return i;
  return -1;
}

/**
 * O `tradutor` do YAML confere com os nomes lidos e verificados no cabeçalho da origem
 * (`verificador.tradutores` do registro): todo nome esperado aparece, e fora deles só conectivos. O nome que a
 * origem não verificou (o caso Harmon no Perseus) reprova.
 */
export function tradutorConfere(tradutor: string, esperados: readonly string[]): boolean {
  let restantes = palavrasDe(tradutor);
  for (const nome of esperados) {
    const sequencia = palavrasDe(nome);
    const onde = acharSequencia(restantes, sequencia);
    if (onde < 0) return false;
    restantes = [...restantes.slice(0, onde), ...restantes.slice(onde + sequencia.length)];
  }
  return restantes.every((p) => SOBRA_PERMITIDA(p, new Set()));
}

/**
 * O sobrenome de um nome do registro, como SEQUÊNCIA de palavras (sem acento nem caixa): "Schaff, Philip (1819-1893)"
 * dá [schaff]; "De Rossi, Giovanni Battista" e "Giovanni Battista de Rossi" dão [de, rossi]; "Hans van der Meer", [van, der, meer].
 */
export function sobrenomeDe(nome: string): string[] {
  const semAnos = nome.replace(/\([^)]*\)/g, " ");
  const virgula = semAnos.indexOf(",");
  if (virgula >= 0) return palavrasDe(semAnos.slice(0, virgula));
  const palavras = palavrasDe(semAnos);
  let inicio = palavras.length - 1;
  while (inicio > 0 && PARTICULAS.has(palavras[inicio - 1] as string)) inicio--;
  return palavras.slice(Math.max(inicio, 0));
}

/**
 * O texto traz o sobrenome: a sequência inteira ("de Rossi", composto), ou, na grafia invertida ("Rossi, Giovanni Battista
 * de"), o miolo seguido com as partículas em qualquer lugar do texto. "Rossi" sozinho NÃO nomeia "de Rossi".
 */
function traz(palavras: readonly string[], nome: string): boolean {
  const seq = sobrenomeDe(nome);
  if (seq.length === 0) return false;
  if (acharSequencia(palavras, seq) >= 0) return true;
  const miolo = seq.filter((p) => !PARTICULAS.has(p));
  const particulas = seq.filter((p) => PARTICULAS.has(p));
  const onde = acharSequencia(palavras, miolo);
  // grafia invertida: as partículas vêm DEPOIS do miolo ("Rossi, Giovanni Battista de"); antes dele são conectivo ("tradução de Rossi")
  return (
    particulas.length > 0 &&
    miolo.length > 0 &&
    onde >= 0 &&
    particulas.every((p) => palavras.indexOf(p, onde + miolo.length) >= 0)
  );
}

/** O `tradutor` do YAML nomeia este editor (pelo nome inteiro ou pelo sobrenome)? */
export function nomeiaOEditor(tradutor: string, editor: string): boolean {
  if (acharSequencia(palavrasDe(tradutor), palavrasDe(editor)) >= 0) return true;
  if (sobrenomeDe(editor).join("").length < 3) return false;
  return traz(palavrasDe(tradutor), editor);
}

export type EvidenciaDoTradutor = { ref: string; tradutores: readonly string[]; trecho: string };

/**
 * O `tradutor` do YAML é o que a evidência nomeia: o sobrenome de cada nome esperado aparece (sem acento nem caixa,
 * composto como sequência), e fora dos nomes esperados só sobram conectivos, partículas e iniciais. Outro nome
 * (Whiston no lugar de Thelwall, ou Thelwall "e Whiston") reprova.
 */
export function tradutorBateComAEvidencia(tradutor: string, esperados: readonly string[]): boolean {
  const palavras = palavrasDe(tradutor);
  const nomes = new Set(esperados.flatMap(palavrasDe));
  return (
    esperados.every((e) => traz(palavras, e)) && palavras.every((p) => SOBRA_PERMITIDA(p, nomes))
  );
}

const resumir = (t: string, max = 140) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** A evidência prova ESTE nome: o trecho nomeia os esperados, o tradutor do YAML os confere e o parágrafo diz o trecho. */
function falhasDeEvidencia(
  tradutor: string,
  ev: EvidenciaDoTradutor,
  contexto: ContextoDaConferencia,
): string[] {
  const falhas: string[] = [];
  const palavrasDoTrecho = palavrasDe(ev.trecho);
  for (const e of ev.tradutores)
    if (!traz(palavrasDoTrecho, e))
      falhas.push(
        `tradutor-evidencia: o trecho registrado de ${ev.ref} não nomeia "${e}" (diz: "${resumir(ev.trecho)}")`,
      );
  if (!tradutorBateComAEvidencia(tradutor, ev.tradutores))
    falhas.push(
      `tradutor-evidencia: "${tradutor}" não é o tradutor que a evidência ${ev.ref} nomeia (${ev.tradutores.join(", ")}; o parágrafo diz: "${resumir(ev.trecho)}")`,
    );
  const { derivado } = contexto;
  if (!derivado) return falhas;
  const paragrafo = derivado.secoes.flatMap((s) => s.paragrafos).find((p) => p.ref === ev.ref);
  if (paragrafo) {
    if (!compactar(paragrafo.texto).includes(compactar(ev.trecho)))
      falhas.push(
        `tradutor-evidencia: o parágrafo ${ev.ref} do derivado não contém o trecho do registro (diz: "${resumir(compactar(paragrafo.texto))}")`,
      );
  } else if (
    (contexto.divisoesDoArquivo ?? []).some(
      (d) => ev.ref === d || ev.ref.startsWith(`${d}.`) || ev.ref.startsWith(`${d}-`),
    )
  ) {
    // A evidência cai numa divisão que ESTA Fonte publica e o parágrafo não está nela: referência errada.
    falhas.push(`tradutor-evidencia: o parágrafo ${ev.ref} não existe no derivado desta Fonte`);
  }
  // Fora das divisões da Fonte o parágrafo não está no derivado: o trecho fixado vale e o `acervo:verify` o prova no bruto.
  return falhas;
}

export type ContextoDaConferencia = {
  /** Nomes lidos e verificados na origem (`verificador.tradutores` do registro). */
  tradutores: readonly string[];
  /** Editores do volume (`verificador.editores`): nunca são tradutor sem evidência. */
  editores?: readonly string[];
  /** O volume (id da origem), para dizer de onde vem o editor na mensagem. */
  volume?: string;
  /**
   * A evidência do tradutor, como o registro a fixa (`evidencia_tradutor`, `tradutor_esperado`, `evidencia_trecho`):
   * a referência do parágrafo da introdução, quem ele nomeia e o trecho exato.
   */
  evidenciaTradutor?: EvidenciaDoTradutor | null;
  /** Divisões do arquivo (`divisoes`): uma evidência dentro delas TEM de estar no derivado. */
  divisoesDoArquivo?: readonly string[];
  /** Editores que a evidência mostra terem traduzido ESTA obra também (`tradutor_tambem_editor`). */
  tradutorTambemEditor?: readonly string[];
  /** O derivado versionado da Fonte; `null` quando não há (Fonte não publicada sem derivado). */
  derivado: Derivado | null;
};

/**
 * Editor do volume não é tradutor (o erro sistêmico de 24/11/2026: Schaff, Menzies e companhia no `tradutor` de obras
 * do CCEL). Reprova o `tradutor` que nomeia um editor do volume, salvo o editor que a evidência da própria obra mostra
 * ter traduzido; e reprova o `tradutor` sem evidência quando a origem não o verifica no cabeçalho.
 */
function falhasDeTradutorEEditor(tradutor: string, contexto: ContextoDaConferencia): string[] {
  const falhas: string[] = [];
  const volume = contexto.volume ? ` ${contexto.volume}` : "";
  for (const editor of contexto.editores ?? []) {
    if (!nomeiaOEditor(tradutor, editor)) continue;
    const excecao =
      Boolean(contexto.evidenciaTradutor) &&
      (contexto.tradutorTambemEditor ?? []).some((e) => e === editor);
    if (!excecao)
      falhas.push(
        `tradutor-e-editor: "${tradutor}" nomeia "${editor}", editor do volume${volume}; o tradutor desta obra é quem a introdução da edição nomeia (registre-o com \`evidencia_tradutor\`) ou fica sem tradutor`,
      );
  }
  if (contexto.tradutores.length === 0) {
    if (contexto.evidenciaTradutor)
      falhas.push(...falhasDeEvidencia(tradutor, contexto.evidenciaTradutor, contexto));
    else
      falhas.push(
        `tradutor-sem-evidencia: "${tradutor}" não tem evidência no registro (\`evidencia_tradutor\`, \`tradutor_esperado\` e \`evidencia_trecho\`: o parágrafo da introdução que nomeia o tradutor); o cabeçalho do volume${volume} não o verifica`,
      );
  }
  return falhas;
}

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
  if (fonte.tradutor) falhas.push(...falhasDeTradutorEEditor(fonte.tradutor, contexto));
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
      tradutores: achado.origem.verificador.tradutores ?? [],
      editores: achado.origem.verificador.editores ?? [],
      volume: achado.origemId,
      evidenciaTradutor:
        achado.arquivo.evidencia_tradutor &&
        achado.arquivo.tradutor_esperado &&
        achado.arquivo.evidencia_trecho
          ? {
              ref: achado.arquivo.evidencia_tradutor,
              tradutores: achado.arquivo.tradutor_esperado,
              trecho: achado.arquivo.evidencia_trecho,
            }
          : null,
      divisoesDoArquivo: achado.arquivo.divisoes ?? [],
      tradutorTambemEditor: achado.arquivo.tradutor_tambem_editor ?? [],
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
    if (a === undefined) continue;
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
