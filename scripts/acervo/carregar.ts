// Carga das Fontes do Acervo no banco como jnf_carga, a partir do derivado (o texto já interpretado e
// versionado no produto). Uma transação só (qualquer erro desfaz tudo), trava consultiva própria, idempotente por
// slug da Fonte, id da seção e id do parágrafo. Nenhuma rede: este módulo só lê o que já está no disco.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { decidirAmbiente } from "../../src/db/ambiente";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { registrarErro } from "../../src/lib/registro";
import {
  type Derivado,
  ErroContrato,
  type FonteYaml,
  interpretarFonteYaml,
} from "../../src/modules/acervo/schemas";
import {
  CAMINHO_ORIGENS,
  conferirOrigemDoDerivado,
  ErroOrigem,
  lerOrigens,
  type Origens,
} from "../ingest/acervo-origens";
import { abrirCarga, ErroCarga } from "../ingest/carregar-biblia";
import {
  CAMINHO_LOCK,
  ErroDerivado,
  type LockDerivados,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "./derivados";
import { hashDoYaml, shaDaEntrada } from "./entrada";

export type Contagem = {
  inseridos: number;
  atualizados: number;
  inalterados: number;
  removidos: number;
};
/** Uma Fonte do arquivo que a carga RECUSOU porque o painel a editou: os campos em conflito, e nada foi escrito nela. */
export type ConflitoDeCarga = { slug: string; campos: string[] };
/** Uma Fonte que a carga PULOU porque o banco já tem uma revisão da entrada MAIOR que a deste build (nada foi escrito). */
export type PuladaPorRevisao = { slug: string; revisaoDoBanco: number; revisaoDoBuild: number };
/** Uma Fonte que a carga RECUSOU porque escreveria mais unidades que o teto (nada foi escrito nela). */
export type RecusadaPeloTeto = { slug: string; unidades: number; teto: number };
export type ResultadoFontes = Contagem & {
  fontes: Contagem;
  secoes: Contagem;
  paragrafos: Contagem;
  /** Fontes recusadas por edição no painel (ACER-08). Não vazio = o comando sai com código 3. */
  conflitos: ConflitoDeCarga[];
  /** Fontes pulada por já existir no banco uma revisão mais nova do derivado: aviso, o comando sai com 0. */
  maisNovasNoBanco: PuladaPorRevisao[];
  /** Fontes recusadas pelo teto de unidades por Fonte. Não vazio = o comando sai com código 3. */
  recusadasPeloTeto: RecusadaPeloTeto[];
  /** O que existe no banco e não está no derivado, e FICOU porque nenhuma remoção o autorizou (a carga nunca apaga sozinha). */
  mantidos: { secoes: number; paragrafos: number };
};

/** Código de saída do comando quando ao menos uma Fonte foi recusada (painel ou teto); distinto de 1 = erro. */
export const CODIGO_DE_CONFLITO = 3;

/**
 * Teto de unidades que UMA carga escreve numa Fonte que já existe (seções e parágrafos novos ou diferentes). Acima
 * disso a Fonte é recusada SEM escrever nada. 250: o maior derivado versionado tem 2.248 parágrafos (o de Josefo,
 * Antiguidades, 1.444) e a mediana é 103, então uma correção editorial de verdade (dezenas de parágrafos) passa
 * folgada, e uma reescrita em massa de uma Fonte grande (um parser que mudou, um derivado de outra versão) para na
 * porta e pede a decisão de quem roda: `acervo:load --teto <n>` à mão. Limita o estrago de um derivado errado.
 */
export const TETO_DE_UNIDADES_POR_FONTE = 250;

/**
 * Teto de unidades (parágrafos e seções, contando os parágrafos que a remoção de uma seção leva) que UMA carga apaga
 * numa Fonte, mesmo autorizadas. 50: remover é ato manual e raro, e o que ele apaga cabe numa lista que se confere a
 * olho; acima disso a carga aborta sem escrever nada e pede `--teto-remocoes <n>`, para um id colado errado, ou uma
 * seção grande demais, não apagar uma obra inteira.
 */
export const TETO_DE_REMOCOES_POR_FONTE = 50;

/** A forma de uma autorização de remoção: tipada, porque o mesmo id pode existir como seção e como parágrafo. */
export const FORMA_DA_AUTORIZACAO = /^(secao|paragrafo):[a-z0-9]+(-[a-z0-9]+)*\/\S+$/;

/**
 * Onde ficam, numa lista de posições (seção numa Fonte, parágrafo numa seção), os itens que a carga RETÉM e que não
 * estão no derivado. `usadas` são as posições do derivado, que ganham as suas de qualquer jeito. O retido que não
 * colide com nenhuma fica onde está; o que colide vai para o fim, numa posição acima de todas as ocupadas, na ordem em
 * que estava. Assim, qualquer mistura de itens retidos e itens inseridos entre eles termina sem duas posições iguais.
 */
export function posicoesDosRetidos(
  usadas: ReadonlySet<number>,
  retidos: readonly { id: string; ordem: number }[],
): Map<string, number> {
  const ordenados = [...retidos].sort((a, b) => a.ordem - b.ordem);
  const resultado = new Map<string, number>();
  const ocupadas = new Set(usadas);
  const colidem: { id: string; ordem: number }[] = [];
  for (const r of ordenados) {
    if (usadas.has(r.ordem)) colidem.push(r);
    else {
      resultado.set(r.id, r.ordem);
      ocupadas.add(r.ordem);
    }
  }
  let proxima = Math.max(0, ...ocupadas) + 1;
  for (const r of colidem) resultado.set(r.id, proxima++);
  return resultado;
}

/**
 * Um item da carga: o YAML da Fonte já validado e o derivado dela já validado. `versao` é a revisão e o sha256 da
 * ENTRADA inteira (o derivado e o YAML, `scripts/acervo/entrada.ts`) no lock: com ela a carga nunca leva uma Fonte para
 * trás, nem por um derivado mais velho nem por um YAML mais velho; sem ela (só testes de unidade da carga) não há essa
 * guarda. O `acervo:load` e o build SEMPRE a passam.
 */
export type FonteParaCarga = {
  fonte: FonteYaml;
  derivado: Derivado;
  versao?: { revisao: number; sha256: string };
};

const LOTE_DE_PARAGRAFOS = 400;
const zero = (): Contagem => ({ inseridos: 0, atualizados: 0, inalterados: 0, removidos: 0 });

/** Pitfall 9: uma seção acima deste teto estoura a página de leitura no celular; a Fonte pode pedir outro. */
export const TETO_SECAO_CARACTERES = 80_000;

const numero = (v: number) => v.toLocaleString("pt-BR");

type LinhaFonte = {
  id: string;
  titulo: string;
  autor: string | null;
  nivel: string;
  tipo_texto: string;
  idioma: string;
  epoca: string | null;
  licenca: string | null;
  licenca_url: string | null;
  origem_nome: string | null;
  origem_url: string | null;
  tradutor: string | null;
  traducao_ano: number | null;
  edicao: string | null;
  traduzida_por_nos: boolean;
  limites_pt: string | null;
  editor: string | null;
  publicada: boolean;
  origem_registro: string;
  hash_ultima_carga: string | null;
  valores_arquivo: Partial<ValoresDaFonte> | null;
  publicada_arquivo: boolean | null;
  conflito_carga: string[];
  entrada_revisao: number | null;
  entrada_sha256: string | null;
};

type LinhaSecao = {
  id: string;
  slug: string;
  ordem: number;
  titulo: string | null;
  resumo_pt: string | null;
  palavras_chave_pt: string[];
  hash_ultima_carga: string | null;
  valores_arquivo: Partial<ValoresDaSecao> | null;
};

type Acumulado = {
  fontes: Contagem;
  secoes: Contagem;
  paragrafos: Contagem;
  conflitos: ConflitoDeCarga[];
  maisNovasNoBanco: PuladaPorRevisao[];
  recusadasPeloTeto: RecusadaPeloTeto[];
  mantidos: { secoes: number; paragrafos: number };
  /** As autorizações de remoção (tipadas) que a carga de fato aplicou (os que sobram são erro: a autorização não casou com nada). */
  remocoesAplicadas: Set<string>;
};

type OpcoesDaCarga = {
  /** Os ids (de parágrafo ou de seção) que ESTA execução está autorizada a apagar. Padrão: nenhum. */
  remocoesAutorizadas: ReadonlySet<string>;
  tetoDeUnidades: number;
  tetoDeRemocoes: number;
};

type LinhaParagrafo = {
  id: string;
  secao_id: string;
  ordem: number;
  texto: string;
  ref: string;
  ref_inicio: number | null;
  ref_fim: number | null;
  idioma: string | null;
};

const n = <T>(v: T | null | undefined): T | null => v ?? null;

// ───────────────────────── o que o arquivo possui (ACER-08) ─────────────────────────
// A carga grava, a cada Fonte e seção, o hash e os valores do que o ARQUIVO disse na última carga. Se o valor atual do
// banco difere do que a última carga gravou (e também do que o arquivo diz agora), alguém o editou no painel: a carga
// recusa a Fonte em vez de sobrescrever. `publicada` não entra aqui: tem mescla de três vias própria.

const CAMPOS_DA_FONTE = [
  "titulo",
  "autor",
  "nivel",
  "tipo_texto",
  "idioma",
  "epoca",
  "licenca",
  "licenca_url",
  "origem_nome",
  "origem_url",
  "tradutor",
  "traducao_ano",
  "edicao",
  "traduzida_por_nos",
  "limites_pt",
  "editor",
] as const;
type CampoDaFonte = (typeof CAMPOS_DA_FONTE)[number];
type ValoresDaFonte = Record<CampoDaFonte, string | number | boolean | null>;

/** O único campo da Fonte do arquivo que o painel edita (os demais são do arquivo). */
const CAMPOS_DA_FONTE_NO_PAINEL: readonly CampoDaFonte[] = ["limites_pt"];
/** Por seção, o que o painel edita: o resumo e as palavras-chave (D-18). */
const CAMPOS_DA_SECAO_NO_PAINEL = ["resumo_pt", "palavras_chave_pt"] as const;
type ValoresDaSecao = {
  titulo: string | null;
  resumo_pt: string | null;
  palavras_chave_pt: string[];
};

const hashDe = (valor: unknown): string =>
  createHash("sha256").update(JSON.stringify(valor)).digest("hex");
const iguais = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function valoresDoYaml(fonte: FonteYaml): ValoresDaFonte {
  return {
    titulo: fonte.titulo,
    autor: n(fonte.autor),
    nivel: fonte.nivel,
    tipo_texto: fonte.tipo_texto,
    idioma: fonte.idioma,
    epoca: n(fonte.epoca),
    licenca: n(fonte.licenca),
    licenca_url: n(fonte.licenca_url),
    origem_nome: n(fonte.origem_nome),
    origem_url: n(fonte.origem_url),
    tradutor: n(fonte.tradutor),
    traducao_ano: n(fonte.traducao_ano),
    edicao: n(fonte.edicao),
    traduzida_por_nos: fonte.traduzida_por_nos,
    limites_pt: n(fonte.limites_pt),
    editor: n(fonte.editor),
  };
}

function valoresDaLinha(l: LinhaFonte): ValoresDaFonte {
  return Object.fromEntries(CAMPOS_DA_FONTE.map((c) => [c, l[c]])) as ValoresDaFonte;
}
const hashDaFonte = (v: ValoresDaFonte): string => hashDe(CAMPOS_DA_FONTE.map((c) => v[c]));
const hashDaSecao = (v: ValoresDaSecao): string =>
  hashDe([v.titulo, v.resumo_pt, v.palavras_chave_pt]);

function conferirItem({ fonte, derivado }: FonteParaCarga): void {
  if (fonte.slug !== derivado.slug)
    throw new ErroCarga(`Fonte ${fonte.slug}: o derivado é de outra Fonte (${derivado.slug})`);
  if (fonte.idioma !== derivado.idioma)
    throw new ErroCarga(`Fonte ${fonte.slug}: o idioma do YAML difere do idioma do derivado`);
  const noDerivado = new Set(derivado.secoes.map((s) => s.slug));
  for (const s of fonte.secoes) {
    if (!noDerivado.has(s.slug))
      throw new ErroCarga(`Fonte ${fonte.slug}: a seção ${s.slug} do YAML não existe no derivado`);
  }
}

/**
 * Recusa, ANTES de abrir a transação, qualquer seção cujo texto passe do teto (80.000 caracteres, ou o que a
 * Fonte registrou em `secao_max_caracteres`): uma obra inteira nunca vira UMA seção por engano (Pitfall 9).
 */
function conferirTetoDeSecao({ fonte, derivado }: FonteParaCarga): void {
  const teto = fonte.secao_max_caracteres?.caracteres ?? TETO_SECAO_CARACTERES;
  for (const s of derivado.secoes) {
    let total = 0;
    for (const p of s.paragrafos) total += p.texto.length;
    if (total > teto)
      throw new ErroCarga(
        `Fonte ${fonte.slug}: a seção ${s.slug} tem ${numero(total)} caracteres de texto, acima do teto de ${numero(teto)} por seção`,
      );
  }
}

type SecaoQuerida = {
  id: string;
  slug: string;
  ordem: number;
  titulo: string;
  resumo: string | null;
  palavras: string[];
};
type ParagrafoQuerido = {
  id: string;
  secaoId: string;
  ordem: number;
  texto: string;
  ref: string;
  refInicio: number | null;
  refFim: number | null;
  idioma: string;
};

const secaoIgual = (a: LinhaSecao, s: SecaoQuerida): boolean =>
  a.ordem === s.ordem &&
  a.titulo === s.titulo &&
  a.resumo_pt === s.resumo &&
  a.palavras_chave_pt.length === s.palavras.length &&
  a.palavras_chave_pt.every((v, i) => v === s.palavras[i]);

const paragrafoIgual = (a: LinhaParagrafo, p: ParagrafoQuerido): boolean =>
  a.secao_id === p.secaoId &&
  a.ordem === p.ordem &&
  a.texto === p.texto &&
  a.ref === p.ref &&
  a.ref_inicio === p.refInicio &&
  a.ref_fim === p.refFim &&
  a.idioma === p.idioma;

export async function carregarFontes(
  itens: readonly FonteParaCarga[],
  opcoes: {
    cliente: pg.Client;
    /**
     * As autorizações, TIPADAS (`secao:<id>` ou `paragrafo:<id>`), do que ESTA execução pode apagar. Padrão: nenhuma. A
     * carga NUNCA apaga por conta própria o que sumiu do derivado: o que sai é só o que alguém listou, de propósito
     * (`acervo:load --remover`).
     * O build de produção não passa lista nenhuma.
     */
    remocoesAutorizadas?: readonly string[];
    /** Teto de unidades escritas por Fonte existente numa carga. Padrão: `TETO_DE_UNIDADES_POR_FONTE`. */
    tetoDeUnidades?: number;
    /** Teto de unidades apagadas por Fonte, mesmo autorizadas. Padrão: `TETO_DE_REMOCOES_POR_FONTE`. */
    tetoDeRemocoes?: number;
  },
): Promise<ResultadoFontes> {
  const c = opcoes.cliente;
  const config: OpcoesDaCarga = {
    remocoesAutorizadas: new Set(opcoes.remocoesAutorizadas ?? []),
    tetoDeUnidades: opcoes.tetoDeUnidades ?? TETO_DE_UNIDADES_POR_FONTE,
    tetoDeRemocoes: opcoes.tetoDeRemocoes ?? TETO_DE_REMOCOES_POR_FONTE,
  };
  // Autorização sem tipo (`fonte-x/1`) é recusada: não diz se é a seção ou o parágrafo, e valeria para os dois.
  for (const a of config.remocoesAutorizadas)
    if (!FORMA_DA_AUTORIZACAO.test(a))
      throw new ErroCarga(
        "remoção: a autorização tem a forma secao:<slug>/<seção> ou paragrafo:<slug>/<ref>",
      );
  for (const item of itens) {
    conferirItem(item);
    conferirTetoDeSecao(item);
  }
  const total: Acumulado = {
    fontes: zero(),
    secoes: zero(),
    paragrafos: zero(),
    conflitos: [],
    maisNovasNoBanco: [],
    recusadasPeloTeto: [],
    mantidos: { secoes: 0, paragrafos: 0 },
    remocoesAplicadas: new Set(),
  };
  await c.query("begin");
  try {
    // A espera pela trava tem prazo: outra carga presa vira erro em 2 minutos, não espera sem fim.
    await c.query("set local lock_timeout = '120s'");
    await c.query("select pg_advisory_xact_lock(hashtext('jnf-carga-acervo'))");
    await c.query("set local lock_timeout = 0");
    const amb = await c.query<{ nome: string }>("select nome from acervo.ambiente");
    if (amb.rows.length !== 1 || !amb.rows[0])
      throw new ErroCarga("marcador de ambiente ausente no banco: rode as migrações");
    decidirAmbiente(amb.rows[0].nome, process.env.VERCEL_ENV);

    for (const item of itens) await carregarUma(c, item, total, config);
    // Autorização de remoção que não casou com nada (id errado, ou de uma Fonte que esta carga pulou) é erro: nada é
    // gravado, em vez de a pessoa achar que apagou.
    const sobrou = [...config.remocoesAutorizadas].filter((id) => !total.remocoesAplicadas.has(id));
    if (sobrou.length > 0)
      throw new ErroCarga(
        `remoção autorizada que não se aplicou a nada (o id não sumiu do derivado, ou a Fonte não foi carregada): ${sobrou.join(", ")}`,
      );
    await c.query("commit");
  } catch (erro) {
    await c.query("rollback").catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
  const soma = (k: keyof Contagem) => total.fontes[k] + total.secoes[k] + total.paragrafos[k];
  return {
    inseridos: soma("inseridos"),
    atualizados: soma("atualizados"),
    inalterados: soma("inalterados"),
    removidos: soma("removidos"),
    fontes: total.fontes,
    secoes: total.secoes,
    paragrafos: total.paragrafos,
    conflitos: total.conflitos,
    maisNovasNoBanco: total.maisNovasNoBanco,
    recusadasPeloTeto: total.recusadasPeloTeto,
    mantidos: total.mantidos,
  };
}

/**
 * Os campos que o painel editou desde a última carga E que o arquivo não diz igual agora. Vazio = sem conflito.
 * Fonte carregada antes da migração 0022 (sem registro da última carga) nunca tem conflito. O resto do que o arquivo
 * possui (título, autor, origem, licença, texto) o painel não edita: se mudou por outro caminho, o arquivo vale.
 */
function camposEditadosNoPainel(
  existente: LinhaFonte,
  secoes: ReadonlyMap<string, LinhaSecao>,
  novos: ValoresDaFonte,
  querSecoes: readonly { id: string; titulo: string; resumo: string | null; palavras: string[] }[],
): { campos: string[]; valores: Record<string, unknown> } {
  const campos: string[] = [];
  // O que o ARQUIVO diz agora para cada campo em conflito: a reversão do painel volta a isto, não ao valor da carga anterior.
  const valores: Record<string, unknown> = {};
  const ultima = existente.valores_arquivo;
  if (existente.hash_ultima_carga !== null && ultima) {
    const atuais = valoresDaLinha(existente);
    if (hashDaFonte(atuais) !== existente.hash_ultima_carga) {
      for (const c of CAMPOS_DA_FONTE_NO_PAINEL)
        if (!iguais(atuais[c], ultima[c] ?? null) && !iguais(atuais[c], novos[c])) {
          campos.push(c);
          valores[c] = novos[c];
        }
    }
  }
  const novasPorId = new Map(querSecoes.map((s) => [s.id, s]));
  for (const [id, a] of secoes) {
    if (a.hash_ultima_carga === null || !a.valores_arquivo) continue;
    const atuais: ValoresDaSecao = {
      titulo: a.titulo,
      resumo_pt: a.resumo_pt,
      palavras_chave_pt: a.palavras_chave_pt,
    };
    if (hashDaSecao(atuais) === a.hash_ultima_carga) continue;
    const q = novasPorId.get(id);
    const novosS: Partial<ValoresDaSecao> = q
      ? { resumo_pt: q.resumo, palavras_chave_pt: q.palavras }
      : {};
    for (const c of CAMPOS_DA_SECAO_NO_PAINEL) {
      const ultimaS = a.valores_arquivo[c] ?? (c === "palavras_chave_pt" ? [] : null);
      if (!iguais(atuais[c], ultimaS) && !(c in novosS && iguais(atuais[c], novosS[c]))) {
        campos.push(`${a.slug}:${c}`);
        // Seção que o arquivo largou: sem valor novo, a reversão cai no da última carga aceita.
        if (c in novosS) valores[`${a.slug}:${c}`] = novosS[c];
      }
    }
  }
  return { campos, valores };
}

async function carregarUma(
  c: pg.Client,
  { fonte, derivado, versao }: FonteParaCarga,
  total: Acumulado,
  config: OpcoesDaCarga,
): Promise<void> {
  const mudancas = () =>
    [total.fontes, total.secoes, total.paragrafos].reduce(
      (soma, k) => soma + k.inseridos + k.atualizados + k.removidos,
      0,
    );
  const mudancasAntes = mudancas();
  // ───── Fonte
  // `for update`: a linha fica travada até o fim da transação. Uma edição do painel em curso (que também trava a
  // linha) faz esta leitura esperar e enxergar a edição; sem isto a carga poderia ler, o painel gravar e a carga
  // escrever por cima do que não viu.
  const existente = (
    await c.query<LinhaFonte>(
      `select id, titulo, autor, nivel, tipo_texto, idioma, epoca, licenca, licenca_url, origem_nome,
              origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, editor, publicada,
              origem_registro, hash_ultima_carga, valores_arquivo, publicada_arquivo, conflito_carga,
              entrada_revisao, entrada_sha256
         from acervo.fonte where slug = $1 for update`,
      [fonte.slug],
    )
  ).rows[0];
  if (existente?.origem_registro === "painel")
    throw new ErroCarga(`Fonte ${fonte.slug}: foi criada pelo painel e a carga nunca a toca`);

  // ───── nunca para trás: o banco já tem uma revisão MAIS NOVA do derivado desta Fonte (build de uma versão
  // anterior, redeploy ou rollback). Nada é lido nem escrito além desta linha: a Fonte fica como está e a carga avisa.
  if (versao && existente && existente.entrada_revisao !== null) {
    if (versao.revisao < existente.entrada_revisao) {
      total.maisNovasNoBanco.push({
        slug: fonte.slug,
        revisaoDoBanco: existente.entrada_revisao,
        revisaoDoBuild: versao.revisao,
      });
      return;
    }
    // Mesma revisão com outro conteúdo: o derivado mudou sem a revisão subir (lock editado à mão). Não há como saber
    // qual dos dois é o mais novo, então não se grava nenhum.
    if (versao.revisao === existente.entrada_revisao && versao.sha256 !== existente.entrada_sha256)
      throw new ErroCarga(
        `Fonte ${fonte.slug}: a revisão ${versao.revisao} da entrada (derivado e YAML) tem outro sha256 que o do banco; a revisão tem de subir quando o derivado ou o YAML muda (acervo:derivar, acervo:travar)`,
      );
  }

  const novosValores = valoresDoYaml(fonte);
  const hashNovo = hashDaFonte(novosValores);

  // ───── o que se quer, pela numeração da obra (nunca pela posição no arquivo)
  const yamlPorSecao = new Map(fonte.secoes.map((s) => [s.slug, s]));
  const querSecoes = derivado.secoes.map((s) => {
    const y = yamlPorSecao.get(s.slug);
    return {
      id: `${fonte.slug}/${s.slug}`,
      slug: s.slug,
      ordem: s.ordem,
      titulo: y?.titulo ?? s.titulo,
      resumo: n(y?.resumo_pt),
      palavras: y?.palavras_chave_pt ?? [],
    };
  });
  const secoesAtuais = new Map(
    (
      await c.query<LinhaSecao>(
        `select id, slug, ordem, titulo, resumo_pt, palavras_chave_pt, hash_ultima_carga, valores_arquivo
           from acervo.fonte_secao where fonte_id = $1`,
        [existente?.id ?? null],
      )
    ).rows.map((r) => [r.id, r]),
  );

  // ───── conflito com o painel (ACER-08): o valor atual difere do que a última carga gravou E do que o arquivo diz agora
  if (existente) {
    const { campos, valores: recusados } = camposEditadosNoPainel(
      existente,
      secoesAtuais,
      novosValores,
      querSecoes,
    );
    if (campos.length > 0) {
      await c.query(
        "update acervo.fonte set conflito_carga = $1::text[], valores_recusados = $2::jsonb where id = $3",
        [campos, JSON.stringify(recusados), existente.id],
      );
      total.conflitos.push({ slug: fonte.slug, campos });
      return;
    }
  }

  const querParagrafos: ParagrafoQuerido[] = derivado.secoes.flatMap((s) =>
    s.paragrafos.map((p, i) => ({
      id: `${fonte.slug}/${p.ref}`,
      secaoId: `${fonte.slug}/${s.slug}`,
      ordem: i + 1,
      texto: p.texto,
      ref: p.ref,
      refInicio: n(p.ref_inicio),
      refFim: n(p.ref_fim),
      idioma: fonte.idioma,
    })),
  );
  const paragrafosAtuais = new Map(
    existente
      ? (
          await c.query<LinhaParagrafo>(
            `select p.id, p.secao_id, p.ordem, p.texto, p.ref, p.ref_inicio, p.ref_fim, p.idioma
               from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
              where s.fonte_id = $1`,
            [existente.id],
          )
        ).rows.map((r) => [r.id, r] as const)
      : [],
  );

  // ───── o que sumiu do derivado: NUNCA sai sozinho. A carga só apaga o que esta execução foi autorizada a apagar,
  // com autorização TIPADA (`secao:<id>` ou `paragrafo:<id>`: o mesmo id pode existir como seção e como parágrafo) e
  // até o teto de remoções; o resto fica, e é contado e avisado. Um build de produção não autoriza nada, então nunca
  // apaga. Parágrafo com Citação não sai nem autorizado: a carga falha e nada é apagado.
  const queFicamP = new Set(querParagrafos.map((p) => p.id));
  const queFicamS = new Set(querSecoes.map((s) => s.id));
  const secoesSumidas = [...secoesAtuais.keys()].filter((id) => !queFicamS.has(id));
  const secoesQueSaem = secoesSumidas.filter((id) => config.remocoesAutorizadas.has(`secao:${id}`));
  // Apagar uma seção leva os parágrafos dela: todos têm de ter sumido do derivado também, senão a remoção é recusada.
  for (const secaoId of secoesQueSaem) {
    const seguem = [...paragrafosAtuais.values()].filter(
      (p) => p.secao_id === secaoId && queFicamP.has(p.id),
    );
    if (seguem.length > 0)
      throw new ErroCarga(
        `Fonte ${fonte.slug}: a seção ${secaoId} ainda tem parágrafos no derivado e não pode ser removida`,
      );
  }
  const paragrafosSumidos = [...paragrafosAtuais.values()].filter((p) => !queFicamP.has(p.id));
  const paragrafosQueSaem = paragrafosSumidos
    .filter(
      (p) =>
        config.remocoesAutorizadas.has(`paragrafo:${p.id}`) || secoesQueSaem.includes(p.secao_id),
    )
    .map((p) => p.id);
  const remocoes = paragrafosQueSaem.length + secoesQueSaem.length;
  if (remocoes > config.tetoDeRemocoes)
    throw new ErroCarga(
      `Fonte ${fonte.slug}: a remoção apagaria ${remocoes} unidades (parágrafos e seções), acima do teto de ${config.tetoDeRemocoes}; nada foi escrito (--teto-remocoes <n> à mão)`,
    );
  if (paragrafosQueSaem.length > 0) {
    const citados = await c.query<{ fonte_paragrafo_id: string }>(
      "select distinct fonte_paragrafo_id from acervo.citacao where fonte_paragrafo_id = any($1::text[])",
      [paragrafosQueSaem],
    );
    if (citados.rows.length > 0)
      throw new ErroCarga(
        `Fonte ${fonte.slug}: o parágrafo ${citados.rows[0]?.fonte_paragrafo_id} saiu do derivado e já tem Citação`,
      );
  }

  // ───── posições dos que FICAM e não estão no derivado: ninguém pode herdar a posição de quem ficou (UNIQUE na
  // posição), então o retido que colide com o derivado vai para o fim, em posição livre; o que não colide não se mexe.
  const saem = new Set(paragrafosQueSaem);
  const retidasS = secoesSumidas
    .filter((id) => !secoesQueSaem.includes(id))
    .map((id) => secoesAtuais.get(id) as LinhaSecao);
  const posicaoDasS = posicoesDosRetidos(new Set(querSecoes.map((x) => x.ordem)), retidasS);
  const moversS = retidasS.filter((r) => posicaoDasS.get(r.id) !== r.ordem);
  const retidosP = paragrafosSumidos.filter((p) => !saem.has(p.id));
  const posicaoDosP = new Map<string, number>();
  for (const secaoId of new Set(retidosP.map((p) => p.secao_id))) {
    const usadas = new Set(querParagrafos.filter((p) => p.secaoId === secaoId).map((p) => p.ordem));
    for (const [id, ordem] of posicoesDosRetidos(
      usadas,
      retidosP.filter((p) => p.secao_id === secaoId),
    ))
      posicaoDosP.set(id, ordem);
  }
  const moversP = retidosP.filter((p) => posicaoDosP.get(p.id) !== p.ordem);

  // ───── teto: numa Fonte que já existe, uma carga que escreveria mais unidades (seções e parágrafos novos, diferentes
  // ou reposicionados) que o teto é recusada ANTES de qualquer escrita nela. Fonte nova só insere.
  if (existente) {
    const unidades =
      querSecoes.filter((x) => {
        const a = secoesAtuais.get(x.id);
        return !a || !secaoIgual(a, x);
      }).length +
      querParagrafos.filter((p) => {
        const a = paragrafosAtuais.get(p.id);
        return !a || !paragrafoIgual(a, p);
      }).length +
      moversS.length +
      moversP.length;
    if (unidades > config.tetoDeUnidades) {
      total.recusadasPeloTeto.push({
        slug: fonte.slug,
        unidades,
        teto: config.tetoDeUnidades,
      });
      return;
    }
  }

  // `publicada`: mescla de três vias (arquivo, última carga, painel). O valor do arquivo só vale se o painel não
  // mexeu desde a última carga; se mexeu, o do painel fica. Sem registro da última carga, vale o do arquivo.
  const publicadaFinal = !existente
    ? fonte.publicada
    : existente.publicada_arquivo === null || existente.publicada === existente.publicada_arquivo
      ? fonte.publicada
      : existente.publicada;

  const valores = [...CAMPOS_DA_FONTE.map((k) => novosValores[k]), publicadaFinal];
  let fonteId: string;
  if (!existente) {
    const novo = await c.query<{ id: string }>(
      `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, epoca, licenca, licenca_url,
         origem_nome, origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, editor, publicada,
         hash_ultima_carga, valores_arquivo, publicada_arquivo)
       values ($18, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $19, $20::jsonb, $21)
       returning id`,
      [...valores, fonte.slug, hashNovo, JSON.stringify(novosValores), fonte.publicada],
    );
    fonteId = (novo.rows[0] as { id: string }).id;
    total.fontes.inseridos++;
  } else {
    fonteId = existente.id;
    const atuais = [...CAMPOS_DA_FONTE.map((k) => existente[k]), existente.publicada];
    if (atuais.every((v, i) => v === valores[i])) {
      total.fontes.inalterados++;
    } else {
      await c.query(
        `update acervo.fonte set titulo = $1, autor = $2, nivel = $3, tipo_texto = $4, idioma = $5, epoca = $6,
           licenca = $7, licenca_url = $8, origem_nome = $9, origem_url = $10, tradutor = $11,
           traducao_ano = $12, edicao = $13, traduzida_por_nos = $14, limites_pt = $15, editor = $16, publicada = $17
         where id = $18`,
        [...valores, fonteId],
      );
      total.fontes.atualizados++;
    }
    // O registro da última carga não é conteúdo: gravá-lo (inclusive em Fonte de antes da migração 0022) não
    // conta como atualização, para a segunda carga seguir com atualizados=0.
    await c.query(
      `update acervo.fonte set hash_ultima_carga = $1, valores_arquivo = $2::jsonb, publicada_arquivo = $3,
         conflito_carga = '{}', valores_recusados = null
       where id = $4 and (hash_ultima_carga is distinct from $1 or valores_arquivo is distinct from $2::jsonb
         or publicada_arquivo is distinct from $3 or conflito_carga <> '{}' or valores_recusados is not null)`,
      [hashNovo, JSON.stringify(novosValores), fonte.publicada, fonteId],
    );
  }

  // ───── remoções autorizadas (já conferidas acima)
  total.mantidos.paragrafos += paragrafosSumidos.length - paragrafosQueSaem.length;
  total.mantidos.secoes += secoesSumidas.length - secoesQueSaem.length;
  for (const id of secoesQueSaem) total.remocoesAplicadas.add(`secao:${id}`);
  for (const id of paragrafosQueSaem)
    if (config.remocoesAutorizadas.has(`paragrafo:${id}`))
      total.remocoesAplicadas.add(`paragrafo:${id}`);
  if (paragrafosQueSaem.length > 0) {
    await c.query("delete from acervo.fonte_paragrafo where id = any($1::text[])", [
      paragrafosQueSaem,
    ]);
    total.paragrafos.removidos += paragrafosQueSaem.length;
  }
  if (secoesQueSaem.length > 0) {
    await c.query("delete from acervo.fonte_secao where id = any($1::text[])", [secoesQueSaem]);
    total.secoes.removidos += secoesQueSaem.length;
  }

  // ───── seções: as que mudam de ordem (as do derivado e as retidas que colidiriam) saem da posição antes (UNIQUE
  // fonte_id, ordem); a posição provisória é negativa e nunca sobrevive à transação.
  const mudamDeOrdemS = querSecoes
    .filter((x) => {
      const a = secoesAtuais.get(x.id);
      return a !== undefined && a.ordem !== x.ordem;
    })
    .map((x) => x.id);
  const paraEstacionarS = [...mudamDeOrdemS, ...moversS.map((r) => r.id)];
  if (paraEstacionarS.length > 0)
    await c.query("update acervo.fonte_secao set ordem = -ordem - 1 where id = any($1::text[])", [
      paraEstacionarS,
    ]);
  // As retidas vão já para a posição livre (acima de todas as usadas): não colidem com nenhuma do derivado.
  if (moversS.length > 0) {
    await c.query(
      `update acervo.fonte_secao s set ordem = v.ordem
         from unnest($1::text[], $2::int4[]) as v(id, ordem) where s.id = v.id`,
      [moversS.map((r) => r.id), moversS.map((r) => posicaoDasS.get(r.id))],
    );
    total.secoes.atualizados += moversS.length;
  }

  for (const s of querSecoes) {
    const a = secoesAtuais.get(s.id);
    const valoresS: ValoresDaSecao = {
      titulo: s.titulo,
      resumo_pt: s.resumo,
      palavras_chave_pt: s.palavras,
    };
    const hashS = hashDaSecao(valoresS);
    if (!a) total.secoes.inseridos++;
    else if (secaoIgual(a, s)) {
      total.secoes.inalterados++;
      // Registro da última carga (também para seção de antes da 0022); não conta como atualização.
      await c.query(
        `update acervo.fonte_secao set hash_ultima_carga = $1, valores_arquivo = $2::jsonb
          where id = $3 and (hash_ultima_carga is distinct from $1 or valores_arquivo is distinct from $2::jsonb)`,
        [hashS, JSON.stringify(valoresS), s.id],
      );
      continue;
    } else total.secoes.atualizados++;
    await c.query(
      `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt, palavras_chave_pt,
         hash_ultima_carga, valores_arquivo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (id) do update set ordem = excluded.ordem, titulo = excluded.titulo,
         resumo_pt = excluded.resumo_pt, palavras_chave_pt = excluded.palavras_chave_pt,
         hash_ultima_carga = excluded.hash_ultima_carga, valores_arquivo = excluded.valores_arquivo`,
      [
        s.id,
        fonteId,
        s.slug,
        s.ordem,
        s.titulo,
        s.resumo,
        s.palavras,
        hashS,
        JSON.stringify(valoresS),
      ],
    );
  }

  // ───── parágrafos: só os novos ou diferentes são gravados, em lotes
  const mudaram: ParagrafoQuerido[] = [];
  for (const p of querParagrafos) {
    const a = paragrafosAtuais.get(p.id);
    if (!a) {
      total.paragrafos.inseridos++;
      mudaram.push(p);
    } else if (paragrafoIgual(a, p)) {
      total.paragrafos.inalterados++;
    } else {
      total.paragrafos.atualizados++;
      mudaram.push(p);
    }
  }
  const saemDaPosicao = [
    ...mudaram
      .filter((p) => {
        const a = paragrafosAtuais.get(p.id);
        return a !== undefined && (a.ordem !== p.ordem || a.secao_id !== p.secaoId);
      })
      .map((p) => p.id),
    ...moversP.map((r) => r.id),
  ];
  if (saemDaPosicao.length > 0)
    await c.query(
      "update acervo.fonte_paragrafo set ordem = -ordem - 1 where id = any($1::text[])",
      [saemDaPosicao],
    );
  // Os retidos vão já para a posição livre (acima de todas as usadas na seção): não colidem com nenhum do derivado.
  if (moversP.length > 0) {
    await c.query(
      `update acervo.fonte_paragrafo p set ordem = v.ordem
         from unnest($1::text[], $2::int2[]) as v(id, ordem) where p.id = v.id`,
      [moversP.map((r) => r.id), moversP.map((r) => posicaoDosP.get(r.id))],
    );
    total.paragrafos.atualizados += moversP.length;
  }
  for (let i = 0; i < mudaram.length; i += LOTE_DE_PARAGRAFOS) {
    const lote = mudaram.slice(i, i + LOTE_DE_PARAGRAFOS);
    await c.query(
      `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, ref_inicio, ref_fim, idioma)
       select * from unnest($1::text[], $2::text[], $3::int2[], $4::text[], $5::text[], $6::int4[], $7::int4[], $8::text[])
       on conflict (id) do update set secao_id = excluded.secao_id, ordem = excluded.ordem,
         texto = excluded.texto, ref = excluded.ref, ref_inicio = excluded.ref_inicio,
         ref_fim = excluded.ref_fim, idioma = excluded.idioma`,
      [
        lote.map((p) => p.id),
        lote.map((p) => p.secaoId),
        lote.map((p) => p.ordem),
        lote.map((p) => p.texto),
        lote.map((p) => p.ref),
        lote.map((p) => p.refInicio),
        lote.map((p) => p.refFim),
        lote.map((p) => p.idioma),
      ],
    );
  }

  // A versão do derivado de que a Fonte foi carregada (a guarda "nunca para trás" lê daqui). Não é conteúdo: não
  // conta como mudança nem sobe a revisão do painel.
  if (versao)
    await c.query(
      `update acervo.fonte set entrada_revisao = $1, entrada_sha256 = $2
        where id = $3 and (entrada_revisao is distinct from $1 or entrada_sha256 is distinct from $2)`,
      [versao.revisao, versao.sha256, fonteId],
    );

  // A Fonte mudou por baixo de quem a tem aberta no painel: a revisão sobe e o formulário velho passa a ser recusado.
  if (existente && mudancas() > mudancasAntes)
    await c.query("update acervo.fonte set revisao = revisao + 1 where id = $1", [fonteId]);
}

// ───────────────────────── comando: pnpm acervo:load ─────────────────────────

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PASTA_FONTES = path.join(RAIZ, "content", "acervo", "fontes");

export type OpcoesDoComando = {
  fontes: string;
  derivados: string;
  lock: string;
  /**
   * Registro de origens (`data/acervo-origens.yaml`). Quando dado, cada derivado só carrega se a origem dele é publicável e
   * ele não traz nada fora das unidades e divisões autorizadas (D-06): a mesma regra do `acervo:verify`, que o build não roda.
   * O comando (`lerOpcoes`) sempre o preenche; só os testes de unidade da carga com pastas fictícias o omitem.
   */
  origens?: string;
  /** Autorizações tipadas (`secao:<id>`, `paragrafo:<id>`) do que ESTA execução pode apagar. Só o `acervo:load` à mão; o build nunca. */
  remover?: readonly string[];
  /** Outro teto de remoções por Fonte, só à mão (`--teto-remocoes`). */
  tetoDeRemocoes?: number;
  /** Outro teto de unidades por Fonte, só à mão (`--teto`). O build usa o padrão. */
  teto?: number;
};
export type DependenciasDoComando = {
  /** Abre o cliente `jnf_carga`. Só é chamado depois de TODA conferência passar. */
  abrir?: () => Promise<pg.Client>;
  escrever?: (linha: string) => void;
};
export type ResultadoDoComando = {
  carregadas: number;
  puladas: string[];
  resultado?: ResultadoFontes;
};

function lerYamls(pasta: string): FonteYaml[] {
  let nomes: string[];
  try {
    nomes = readdirSync(pasta)
      .filter((n) => n.endsWith(".yaml"))
      .sort();
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw erro;
  }
  return nomes.map((nome) =>
    interpretarFonteYaml(readFileSync(path.join(pasta, nome), "utf8"), nome),
  );
}

/**
 * A revisão e o sha256 da entrada de uma Fonte: o YAML lido tem de ser o que o lock travou (senão o YAML mudou sem a
 * revisão subir, e não há como saber qual é o mais novo), e o sha256 da entrada junta o do derivado e o do YAML.
 */
function versaoDaEntrada(
  lock: LockDerivados,
  fonte: FonteYaml,
): { revisao: number; sha256: string } {
  const entrada = lock.derivados[fonte.slug];
  if (!entrada) throw new ErroDerivado(`derivado ${fonte.slug}: fora do lock`);
  const yaml = hashDoYaml(fonte);
  if (yaml !== entrada.yaml_sha256)
    throw new ErroDerivado(
      `Fonte ${fonte.slug}: o YAML mudou sem a revisão subir no lock (rode pnpm acervo:travar e faça o commit do lock)`,
    );
  return { revisao: entrada.revisao, sha256: shaDaEntrada(entrada.sha256, yaml) };
}

function lerOrigensParaCarga(caminho: string): Origens {
  try {
    return lerOrigens(caminho);
  } catch (erro) {
    if (erro instanceof ErroOrigem) throw new ErroCarga(`registro de origens: ${erro.message}`);
    throw erro;
  }
}

function conferirOrigem(
  slug: string,
  derivado: Parameters<typeof conferirOrigemDoDerivado>[1],
  origens: Origens,
): void {
  try {
    conferirOrigemDoDerivado(slug, derivado, origens);
  } catch (erro) {
    if (erro instanceof ErroOrigem) throw new ErroDerivado(erro.message);
    throw erro;
  }
}

/**
 * Confere o lock, o orçamento e o contrato de cada YAML e de cada derivado, TUDO antes de criar o cliente do banco;
 * só então carrega. Sem derivado a carregar, não abre conexão. Erro lança (o comando sai com 1); nada é gravado.
 */
export async function executarCarga(
  opcoes: OpcoesDoComando,
  deps: DependenciasDoComando = {},
): Promise<ResultadoDoComando> {
  const escrever = deps.escrever ?? ((l: string) => console.log(l));
  const lock = lerLock(opcoes.lock);
  const conferidos = verificarDerivados(opcoes.derivados, lock);
  const yamls = lerYamls(opcoes.fontes);

  const origens = opcoes.origens ? lerOrigensParaCarga(opcoes.origens) : undefined;
  const slugsDosYamls = new Set(yamls.map((y) => y.slug));
  for (const d of conferidos) {
    if (!slugsDosYamls.has(d.slug))
      throw new ErroDerivado(`derivado ${d.slug}: não há YAML de Fonte com esse slug`);
  }
  const itens: FonteParaCarga[] = [];
  const puladas: string[] = [];
  const comDerivado = new Set(conferidos.map((d) => d.slug));
  for (const fonte of yamls) {
    if (comDerivado.has(fonte.slug)) {
      const derivado = lerDerivado(opcoes.derivados, lock, fonte.slug);
      if (origens) conferirOrigem(fonte.slug, derivado, origens);
      itens.push({
        fonte,
        derivado,
        // Revisão e sha256 da ENTRADA (derivado + YAML) do lock já conferido: a carga nunca leva uma Fonte para uma
        // revisão menor que a do banco.
        versao: versaoDaEntrada(lock, fonte),
      });
    } else if (fonte.publicada) {
      throw new ErroCarga(`Fonte ${fonte.slug}: publicada e sem derivado`);
    } else {
      puladas.push(fonte.slug);
    }
  }
  if (puladas.length > 0)
    escrever(`puladas (não publicadas e sem derivado): ${puladas.join(", ")}`);
  for (const { fonte } of itens)
    if (fonte.secao_max_caracteres)
      escrever(
        `exceção de teto de seção: ${fonte.slug} até ${fonte.secao_max_caracteres.caracteres} caracteres — ${fonte.secao_max_caracteres.motivo}`,
      );
  if (itens.length === 0) {
    escrever("acervo:load: não há derivado a carregar");
    return { carregadas: 0, puladas };
  }

  const abrir = deps.abrir ?? abrirCarga;
  const cliente = await abrir();
  try {
    const resultado = await carregarFontes(itens, {
      cliente,
      remocoesAutorizadas: opcoes.remover,
      tetoDeUnidades: opcoes.teto,
      tetoDeRemocoes: opcoes.tetoDeRemocoes,
    });
    escrever(
      `inseridos=${resultado.inseridos} atualizados=${resultado.atualizados} inalterados=${resultado.inalterados} removidos=${resultado.removidos}`,
    );
    for (const m of resultado.maisNovasNoBanco)
      escrever(
        `aviso: ${m.slug}: o banco já tem a revisão ${m.revisaoDoBanco} da entrada (derivado e YAML) e este build traz a ${m.revisaoDoBuild}; a carga não a tocou (build de uma versão anterior?).`,
      );
    for (const r of resultado.recusadasPeloTeto)
      escrever(
        `recusada: ${r.slug} escreveria ${r.unidades} unidades, acima do teto de ${r.teto} por Fonte; nada foi escrito nela. Se a mudança é esperada, rode acervo:load à mão com --teto <n>.`,
      );
    if (resultado.mantidos.paragrafos + resultado.mantidos.secoes > 0)
      escrever(
        `aviso: ficaram no banco ${resultado.mantidos.paragrafos} parágrafos e ${resultado.mantidos.secoes} seções que não estão mais no derivado; a carga não apaga sozinha (acervo:load --remover secao:<id> ou paragrafo:<id> à mão).`,
      );
    for (const c of resultado.conflitos)
      escrever(
        `conflito: ${c.slug} foi editada no painel (${c.campos.join(", ")}); a carga não a tocou e nada foi sobrescrito. No painel: "Reverter ao arquivo", ou atualize o arquivo e rode a carga de novo.`,
      );
    escrever(
      `fontes=${itens.length} secoes=${resultado.secoes.inseridos + resultado.secoes.atualizados + resultado.secoes.inalterados} paragrafos=${resultado.paragrafos.inseridos + resultado.paragrafos.atualizados + resultado.paragrafos.inalterados}`,
    );
    return { carregadas: itens.length, puladas, resultado };
  } finally {
    await cliente.end().catch(() => {});
  }
}

/**
 * 0 limpo; 3 quando ao menos uma Fonte foi recusada (edição no painel ou teto de unidades; a carga do resto aconteceu).
 * Fonte pulada por revisão mais nova no banco é só aviso: sai 0.
 */
export function codigoDeSaida(r: ResultadoDoComando): number {
  const x = r.resultado;
  return x && (x.conflitos.length > 0 || x.recusadasPeloTeto.length > 0) ? CODIGO_DE_CONFLITO : 0;
}

const USO =
  "Uso: acervo:load [--fontes <pasta>] [--derivados <pasta>] [--lock <arquivo>] [--origens <arquivo>] [--remover <secao:id,paragrafo:id,...>] [--teto <n>] [--teto-remocoes <n>]";

export function lerOpcoes(argumentos: string[]): OpcoesDoComando {
  const valorBruto = (flag: string): string | undefined => {
    const i = argumentos.indexOf(flag);
    if (i < 0) return undefined;
    const v = argumentos[i + 1];
    if (!v) throw new ErroCarga(USO);
    return v;
  };
  const valor = (flag: string, padrao: string): string => {
    const v = valorBruto(flag);
    return v === undefined ? padrao : path.resolve(v);
  };
  const lista = (flag: string): string[] | undefined => {
    const i = argumentos.indexOf(flag);
    if (i < 0) return undefined;
    const v = argumentos[i + 1];
    if (!v) throw new ErroCarga(USO);
    return v.split(",").map((x) => x.trim());
  };
  const remover = lista("--remover");
  if (remover?.some((a) => !FORMA_DA_AUTORIZACAO.test(a)))
    throw new ErroCarga(
      "--remover: cada autorização é tipada, secao:<slug>/<seção> ou paragrafo:<slug>/<ref>",
    );
  const inteiro = (flag: string): number | undefined => {
    const texto = valorBruto(flag);
    if (texto === undefined) return undefined;
    const numero = Number(texto);
    if (!Number.isInteger(numero) || numero < 1)
      throw new ErroCarga(`${flag}: um inteiro maior que zero`);
    return numero;
  };
  const teto = inteiro("--teto");
  const tetoDeRemocoes = inteiro("--teto-remocoes");
  return {
    fontes: valor("--fontes", PASTA_FONTES),
    derivados: valor("--derivados", PASTA_DERIVADOS),
    lock: valor("--lock", CAMINHO_LOCK),
    origens: valor("--origens", CAMINHO_ORIGENS),
    ...(remover ? { remover } : {}),
    ...(teto === undefined ? {} : { teto }),
    ...(tetoDeRemocoes === undefined ? {} : { tetoDeRemocoes }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executarCarga(lerOpcoes(process.argv.slice(2))).then(
    (r) => process.exit(codigoDeSaida(r)),
    (erro) => {
      // Só erro nosso mostra texto; o resto vai só com código e classe (a URL do banco é segredo).
      if (erro instanceof ErroDerivado || erro instanceof ErroContrato || erro instanceof ErroCarga)
        console.error(erro.message);
      else registrarErro("acervo-load", erro);
      process.exit(1);
    },
  );
}
