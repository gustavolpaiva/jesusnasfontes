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
import { abrirCarga, ErroCarga } from "../ingest/carregar-biblia";
import {
  CAMINHO_LOCK,
  ErroDerivado,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "./derivados";

export type Contagem = {
  inseridos: number;
  atualizados: number;
  inalterados: number;
  removidos: number;
};
/** Uma Fonte do arquivo que a carga RECUSOU porque o painel a editou: os campos em conflito, e nada foi escrito nela. */
export type ConflitoDeCarga = { slug: string; campos: string[] };
export type ResultadoFontes = Contagem & {
  fontes: Contagem;
  secoes: Contagem;
  paragrafos: Contagem;
  /** Fontes recusadas por edição no painel (ACER-08). Não vazio = o comando sai com código 3. */
  conflitos: ConflitoDeCarga[];
};

/** Código de saída do comando quando ao menos uma Fonte foi recusada por edição no painel (distinto de 1 = erro). */
export const CODIGO_DE_CONFLITO = 3;

/** Um item da carga: o YAML da Fonte já validado e o derivado dela já validado. */
export type FonteParaCarga = { fonte: FonteYaml; derivado: Derivado };

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
  publicada: boolean;
  origem_registro: string;
  hash_ultima_carga: string | null;
  valores_arquivo: Partial<ValoresDaFonte> | null;
  publicada_arquivo: boolean | null;
  conflito_carga: string[];
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

export async function carregarFontes(
  itens: readonly FonteParaCarga[],
  opcoes: { cliente: pg.Client },
): Promise<ResultadoFontes> {
  const c = opcoes.cliente;
  for (const item of itens) {
    conferirItem(item);
    conferirTetoDeSecao(item);
  }
  const total: Acumulado = {
    fontes: zero(),
    secoes: zero(),
    paragrafos: zero(),
    conflitos: [],
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

    for (const item of itens) await carregarUma(c, item, total);
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
    ...total,
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
): string[] {
  const campos: string[] = [];
  const ultima = existente.valores_arquivo;
  if (existente.hash_ultima_carga !== null && ultima) {
    const atuais = valoresDaLinha(existente);
    if (hashDaFonte(atuais) !== existente.hash_ultima_carga) {
      for (const c of CAMPOS_DA_FONTE_NO_PAINEL)
        if (!iguais(atuais[c], ultima[c] ?? null) && !iguais(atuais[c], novos[c])) campos.push(c);
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
      if (!iguais(atuais[c], ultimaS) && !(c in novosS && iguais(atuais[c], novosS[c])))
        campos.push(`${a.slug}:${c}`);
    }
  }
  return campos;
}

async function carregarUma(
  c: pg.Client,
  { fonte, derivado }: FonteParaCarga,
  total: Acumulado,
): Promise<void> {
  // ───── Fonte
  // `for update`: a linha fica travada até o fim da transação. Uma edição do painel em curso (que também trava a
  // linha) faz esta leitura esperar e enxergar a edição; sem isto a carga poderia ler, o painel gravar e a carga
  // escrever por cima do que não viu.
  const existente = (
    await c.query<LinhaFonte>(
      `select id, titulo, autor, nivel, tipo_texto, idioma, epoca, licenca, licenca_url, origem_nome,
              origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, publicada,
              origem_registro, hash_ultima_carga, valores_arquivo, publicada_arquivo, conflito_carga
         from acervo.fonte where slug = $1 for update`,
      [fonte.slug],
    )
  ).rows[0];
  if (existente?.origem_registro === "painel")
    throw new ErroCarga(`Fonte ${fonte.slug}: foi criada pelo painel e a carga nunca a toca`);

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
    const campos = camposEditadosNoPainel(existente, secoesAtuais, novosValores, querSecoes);
    if (campos.length > 0) {
      await c.query("update acervo.fonte set conflito_carga = $1::text[] where id = $2", [
        campos,
        existente.id,
      ]);
      total.conflitos.push({ slug: fonte.slug, campos });
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
         origem_nome, origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, publicada,
         hash_ultima_carga, valores_arquivo, publicada_arquivo)
       values ($17, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $18, $19::jsonb, $20)
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
           traducao_ano = $12, edicao = $13, traduzida_por_nos = $14, limites_pt = $15, publicada = $16
         where id = $17`,
        [...valores, fonteId],
      );
      total.fontes.atualizados++;
    }
    // O registro da última carga não é conteúdo: gravá-lo (inclusive em Fonte de antes da migração 0022) não
    // conta como atualização, para a segunda carga seguir com atualizados=0.
    await c.query(
      `update acervo.fonte set hash_ultima_carga = $1, valores_arquivo = $2::jsonb, publicada_arquivo = $3,
         conflito_carga = '{}'
       where id = $4 and (hash_ultima_carga is distinct from $1 or valores_arquivo is distinct from $2::jsonb
         or publicada_arquivo is distinct from $3 or conflito_carga <> '{}')`,
      [hashNovo, JSON.stringify(novosValores), fonte.publicada, fonteId],
    );
  }

  const querParagrafos = derivado.secoes.flatMap((s) =>
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
    (
      await c.query<LinhaParagrafo>(
        `select p.id, p.secao_id, p.ordem, p.texto, p.ref, p.ref_inicio, p.ref_fim, p.idioma
           from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
          where s.fonte_id = $1`,
        [fonteId],
      )
    ).rows.map((r) => [r.id, r]),
  );

  // ───── o que sumiu do derivado: só sai sem Citação; com Citação a carga falha e nada é apagado
  const queFicamP = new Set(querParagrafos.map((p) => p.id));
  const queFicamS = new Set(querSecoes.map((s) => s.id));
  const paragrafosQueSaem = [...paragrafosAtuais.keys()].filter((id) => !queFicamP.has(id));
  if (paragrafosQueSaem.length > 0) {
    const citados = await c.query<{ fonte_paragrafo_id: string }>(
      "select distinct fonte_paragrafo_id from acervo.citacao where fonte_paragrafo_id = any($1::text[])",
      [paragrafosQueSaem],
    );
    if (citados.rows.length > 0)
      throw new ErroCarga(
        `Fonte ${fonte.slug}: o parágrafo ${citados.rows[0]?.fonte_paragrafo_id} saiu do derivado e já tem Citação`,
      );
    await c.query("delete from acervo.fonte_paragrafo where id = any($1::text[])", [
      paragrafosQueSaem,
    ]);
    total.paragrafos.removidos += paragrafosQueSaem.length;
  }
  const secoesQueSaem = [...secoesAtuais.keys()].filter((id) => !queFicamS.has(id));
  if (secoesQueSaem.length > 0) {
    await c.query("delete from acervo.fonte_secao where id = any($1::text[])", [secoesQueSaem]);
    total.secoes.removidos += secoesQueSaem.length;
  }

  // ───── seções: as que mudam de ordem saem da posição antes (UNIQUE fonte_id, ordem); a posição
  // provisória é negativa e nunca sobrevive à transação.
  const mudamDeOrdemS = querSecoes
    .filter((s) => {
      const a = secoesAtuais.get(s.id);
      return a !== undefined && a.ordem !== s.ordem;
    })
    .map((s) => s.id);
  if (mudamDeOrdemS.length > 0)
    await c.query("update acervo.fonte_secao set ordem = -ordem - 1 where id = any($1::text[])", [
      mudamDeOrdemS,
    ]);
  for (const s of querSecoes) {
    const a = secoesAtuais.get(s.id);
    const valoresS: ValoresDaSecao = {
      titulo: s.titulo,
      resumo_pt: s.resumo,
      palavras_chave_pt: s.palavras,
    };
    const hashS = hashDaSecao(valoresS);
    if (!a) total.secoes.inseridos++;
    else if (
      a.ordem === s.ordem &&
      a.titulo === s.titulo &&
      a.resumo_pt === s.resumo &&
      a.palavras_chave_pt.length === s.palavras.length &&
      a.palavras_chave_pt.every((v, i) => v === s.palavras[i])
    ) {
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
  const mudaram: typeof querParagrafos = [];
  for (const p of querParagrafos) {
    const a = paragrafosAtuais.get(p.id);
    if (!a) {
      total.paragrafos.inseridos++;
      mudaram.push(p);
    } else if (
      a.secao_id === p.secaoId &&
      a.ordem === p.ordem &&
      a.texto === p.texto &&
      a.ref === p.ref &&
      a.ref_inicio === p.refInicio &&
      a.ref_fim === p.refFim &&
      a.idioma === p.idioma
    ) {
      total.paragrafos.inalterados++;
    } else {
      total.paragrafos.atualizados++;
      mudaram.push(p);
    }
  }
  const saemDaPosicao = mudaram
    .filter((p) => {
      const a = paragrafosAtuais.get(p.id);
      return a !== undefined && (a.ordem !== p.ordem || a.secao_id !== p.secaoId);
    })
    .map((p) => p.id);
  if (saemDaPosicao.length > 0)
    await c.query(
      "update acervo.fonte_paragrafo set ordem = -ordem - 1 where id = any($1::text[])",
      [saemDaPosicao],
    );
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
}

// ───────────────────────── comando: pnpm acervo:load ─────────────────────────

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PASTA_FONTES = path.join(RAIZ, "content", "acervo", "fontes");

export type OpcoesDoComando = { fontes: string; derivados: string; lock: string };
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
      itens.push({ fonte, derivado: lerDerivado(opcoes.derivados, lock, fonte.slug) });
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
    const resultado = await carregarFontes(itens, { cliente });
    escrever(
      `inseridos=${resultado.inseridos} atualizados=${resultado.atualizados} inalterados=${resultado.inalterados} removidos=${resultado.removidos}`,
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

/** 0 limpo; 3 quando ao menos uma Fonte foi recusada por edição no painel (a carga do resto aconteceu). */
export function codigoDeSaida(r: ResultadoDoComando): number {
  return r.resultado && r.resultado.conflitos.length > 0 ? CODIGO_DE_CONFLITO : 0;
}

function lerOpcoes(argumentos: string[]): OpcoesDoComando {
  const valor = (flag: string, padrao: string): string => {
    const i = argumentos.indexOf(flag);
    if (i < 0) return padrao;
    const v = argumentos[i + 1];
    if (!v)
      throw new ErroCarga(
        "Uso: acervo:load [--fontes <pasta>] [--derivados <pasta>] [--lock <arquivo>]",
      );
    return path.resolve(v);
  };
  return {
    fontes: valor("--fontes", PASTA_FONTES),
    derivados: valor("--derivados", PASTA_DERIVADOS),
    lock: valor("--lock", CAMINHO_LOCK),
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
