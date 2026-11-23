// Carga das Fontes do Acervo no banco como jnf_carga, a partir do derivado (o texto já interpretado e
// versionado no produto). Uma transação só (qualquer erro desfaz tudo), trava consultiva própria, idempotente por
// slug da Fonte, id da seção e id do parágrafo. Nenhuma rede: este módulo só lê o que já está no disco.

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
export type ResultadoFontes = Contagem & {
  fontes: Contagem;
  secoes: Contagem;
  paragrafos: Contagem;
};

/** Um item da carga: o YAML da Fonte já validado e o derivado dela já validado. */
export type FonteParaCarga = { fonte: FonteYaml; derivado: Derivado };

const LOTE_DE_PARAGRAFOS = 400;
const zero = (): Contagem => ({ inseridos: 0, atualizados: 0, inalterados: 0, removidos: 0 });

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
};

type LinhaSecao = {
  id: string;
  ordem: number;
  titulo: string | null;
  resumo_pt: string | null;
  palavras_chave_pt: string[];
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

export async function carregarFontes(
  itens: readonly FonteParaCarga[],
  opcoes: { cliente: pg.Client },
): Promise<ResultadoFontes> {
  const c = opcoes.cliente;
  for (const item of itens) conferirItem(item);
  const total = { fontes: zero(), secoes: zero(), paragrafos: zero() };
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

async function carregarUma(
  c: pg.Client,
  { fonte, derivado }: FonteParaCarga,
  total: { fontes: Contagem; secoes: Contagem; paragrafos: Contagem },
): Promise<void> {
  // ───── Fonte
  const existente = (
    await c.query<LinhaFonte>(
      `select id, titulo, autor, nivel, tipo_texto, idioma, epoca, licenca, licenca_url, origem_nome,
              origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, publicada,
              origem_registro
         from acervo.fonte where slug = $1`,
      [fonte.slug],
    )
  ).rows[0];
  if (existente?.origem_registro === "painel")
    throw new ErroCarga(`Fonte ${fonte.slug}: foi criada pelo painel e a carga nunca a toca`);

  const valores = [
    fonte.titulo,
    n(fonte.autor),
    fonte.nivel,
    fonte.tipo_texto,
    fonte.idioma,
    n(fonte.epoca),
    n(fonte.licenca),
    n(fonte.licenca_url),
    n(fonte.origem_nome),
    n(fonte.origem_url),
    n(fonte.tradutor),
    n(fonte.traducao_ano),
    n(fonte.edicao),
    fonte.traduzida_por_nos,
    n(fonte.limites_pt),
    fonte.publicada,
  ];
  let fonteId: string;
  if (!existente) {
    const novo = await c.query<{ id: string }>(
      `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, epoca, licenca, licenca_url,
         origem_nome, origem_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, publicada)
       values ($17, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
      [...valores, fonte.slug],
    );
    fonteId = (novo.rows[0] as { id: string }).id;
    total.fontes.inseridos++;
  } else {
    fonteId = existente.id;
    const atuais = [
      existente.titulo,
      existente.autor,
      existente.nivel,
      existente.tipo_texto,
      existente.idioma,
      existente.epoca,
      existente.licenca,
      existente.licenca_url,
      existente.origem_nome,
      existente.origem_url,
      existente.tradutor,
      existente.traducao_ano,
      existente.edicao,
      existente.traduzida_por_nos,
      existente.limites_pt,
      existente.publicada,
    ];
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
  }

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

  const secoesAtuais = new Map(
    (
      await c.query<LinhaSecao>(
        "select id, ordem, titulo, resumo_pt, palavras_chave_pt from acervo.fonte_secao where fonte_id = $1",
        [fonteId],
      )
    ).rows.map((r) => [r.id, r]),
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
    if (!a) total.secoes.inseridos++;
    else if (
      a.ordem === s.ordem &&
      a.titulo === s.titulo &&
      a.resumo_pt === s.resumo &&
      a.palavras_chave_pt.length === s.palavras.length &&
      a.palavras_chave_pt.every((v, i) => v === s.palavras[i])
    ) {
      total.secoes.inalterados++;
      continue;
    } else total.secoes.atualizados++;
    await c.query(
      `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt, palavras_chave_pt)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set ordem = excluded.ordem, titulo = excluded.titulo,
         resumo_pt = excluded.resumo_pt, palavras_chave_pt = excluded.palavras_chave_pt`,
      [s.id, fonteId, s.slug, s.ordem, s.titulo, s.resumo, s.palavras],
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
    escrever(
      `fontes=${itens.length} secoes=${resultado.secoes.inseridos + resultado.secoes.atualizados + resultado.secoes.inalterados} paragrafos=${resultado.paragrafos.inseridos + resultado.paragrafos.atualizados + resultado.paragrafos.inalterados}`,
    );
    return { carregadas: itens.length, puladas, resultado };
  } finally {
    await cliente.end().catch(() => {});
  }
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
    () => process.exit(0),
    (erro) => {
      // Só erro nosso mostra texto; o resto vai só com código e classe (a URL do banco é segredo).
      if (erro instanceof ErroDerivado || erro instanceof ErroContrato || erro instanceof ErroCarga)
        console.error(erro.message);
      else registrarErro("acervo-load", erro);
      process.exit(1);
    },
  );
}
