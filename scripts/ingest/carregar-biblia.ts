// Do arquivo ao banco: leitura verificada da Bíblia Livre (sha256 contra o lock ANTES de interpretar,
// validação com o esperado) e carga por edição como jnf_carga, numa transação, sem apagar nada.
// Nada aqui interpreta o arquivo de outro jeito que `pnpm ingest:verify`: as mesmas funções, na mesma ordem.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { decidirAmbiente } from "../../src/db/ambiente";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { urlDoPapel } from "../../src/db/url";
import { decompor } from "../../src/modules/referencias/chave";
import { LIVROS } from "../../src/modules/referencias/livros";
import { parsearReferencia } from "../../src/modules/referencias/parser";
import {
  buscarArquivo,
  CAMINHO_LOCK,
  DIR_RAW,
  EDICOES,
  type Edicao,
  lerLock,
  lerRegistro,
  type Registro,
  sha256,
  urlArquivo,
} from "./fontes";
import {
  carregarTabela,
  interpretarF4,
  type LinhaTabela,
  mapaDePrefixos,
  type Versiculo,
} from "./parser-f4";
import { validarEdicao } from "./validar";

// Erro nosso, com texto seguro (só nomes de livro, números e edições): pode ir ao terminal.
export class ErroCarga extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroCarga";
  }
}

export const CONJUNTO_ID = "biblia-livre";
export const textoIdDe = (edicao: Edicao): string => `blivre-${edicao}`;
const NOME_DO_TEXTO: Record<Edicao, string> = {
  n4: "Bíblia Livre, Novo Testamento pelo texto crítico (Nestle 1904)",
  tr: "Bíblia Livre, Novo Testamento pelo Textus Receptus",
};

const LOTE_DE_LINHAS = 1000;
const LOTE_DE_ARQUIVOS = 8;

// ───────────────────────── leitura verificada ─────────────────────────

export type EdicaoLida = {
  edicao: Edicao;
  versiculos: Versiculo[];
  /** Marcador do arquivo-fonte (Mt.1.1) de cada versículo, lido da própria linha `\v`. */
  marcadores: Map<number, string>;
  /** Versículos cujo texto o arquivo traz dentro de outro (Mc 5:19), com o marcador de cada um. */
  mesclados: Mesclado[];
  livros: number[];
  completa: boolean;
};

export type Mesclado = { refExterna: string; chave: number; observacao: string };

async function emLotes<T>(itens: readonly T[], f: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < itens.length; i += LOTE_DE_ARQUIVOS) {
    await Promise.all(itens.slice(i, i + LOTE_DE_ARQUIVOS).map(f));
  }
}

const RE_LINHA_V = /^\\v[ \t]+(\S+)[ \t\r]*$/gm;

function prefixoDoLivro(tabela: readonly LinhaTabela[], livro: number): string {
  const l = tabela.find((x) => x.livro === livro);
  if (!l) throw new ErroCarga(`a tabela de correspondência não tem o livro ${livro}`);
  return l.prefixo;
}

function marcadorDe(tabela: readonly LinhaTabela[], chave: number): string {
  const p = decompor(chave);
  return `${prefixoDoLivro(tabela, p.livro)}.${p.capitulo}.${p.versiculo}`;
}

function mescladosDoRegistro(
  registro: Registro,
  tabela: readonly LinhaTabela[],
  livros: ReadonlySet<number>,
): Mesclado[] {
  const saida: Mesclado[] = [];
  for (const e of registro.esperado?.excecoes ?? []) {
    if (e.tipo !== "versiculo-mesclado")
      throw new ErroCarga(`tipo de exceção desconhecido: ${e.tipo}`);
    const a = parsearReferencia(e.referencia)[0];
    const d = parsearReferencia(e.dentro_de)[0];
    if (!a || !d || a.inicio !== a.fim || d.inicio !== d.fim)
      throw new ErroCarga(`exceção malformada: ${e.referencia} dentro de ${e.dentro_de}`);
    if (!livros.has(decompor(a.inicio).livro)) continue;
    saida.push({
      refExterna: marcadorDe(tabela, a.inicio),
      chave: a.inicio,
      observacao: `texto dentro de ${marcadorDe(tabela, d.inicio)}`,
    });
  }
  return saida;
}

/**
 * Baixa (ou lê do cache) os arquivos da edição, confere o sha256 de cada um contra o lock ANTES de
 * interpretar, interpreta com as correções do registro e valida. Sem `arquivos`, a edição inteira
 * (66 livros) e a validação completa; com `arquivos`, só esses livros e a validação parcial.
 */
export async function lerEdicaoVerificada(
  edicao: Edicao,
  opcoes: { arquivos?: readonly string[] } = {},
): Promise<EdicaoLida> {
  const registro = await lerRegistro();
  const lock = await lerLock();
  const tabela = carregarTabela();
  const mapa = mapaDePrefixos(tabela);
  if (!registro.esperado) throw new ErroCarga("datasets.yaml sem esperado");
  const escolhidas = opcoes.arquivos
    ? tabela.filter((l) => opcoes.arquivos?.includes(l.arquivo))
    : tabela;
  if (opcoes.arquivos && escolhidas.length !== opcoes.arquivos.length)
    throw new ErroCarga("arquivo pedido fora da tabela de livros");
  const completa = escolhidas.length === tabela.length;

  const conteudos = new Map<string, Uint8Array>();
  await emLotes(escolhidas, async (l) => {
    const chaveLock = `${edicao}/${l.arquivo}`;
    const esperado = lock.arquivos[chaveLock];
    if (!esperado) throw new ErroCarga(`o lock não tem ${chaveLock}`);
    const r = await buscarArquivo(
      urlArquivo(edicao, l.arquivo),
      path.join(DIR_RAW, edicao, l.arquivo),
      esperado,
    );
    conteudos.set(chaveLock, r.conteudo);
  });

  const versiculos: Versiculo[] = [];
  const marcadores = new Map<number, string>();
  let aplicadas = 0;
  let listadas = 0;
  for (const l of escolhidas) {
    const nome = `${edicao}/${l.arquivo}`;
    const correcoes = registro.correcoes_marcacao.filter(
      (c) => c.edicao === edicao && c.arquivo === l.arquivo,
    );
    listadas += correcoes.length;
    const rel = { correcoesAplicadas: 0 };
    const texto = new TextDecoder("utf-8", { fatal: true }).decode(conteudos.get(nome));
    const vs = interpretarF4(texto, mapa, correcoes, rel);
    aplicadas += rel.correcoesAplicadas;
    for (const v of vs) {
      if (Math.floor(v.chave / 1_000_000) !== l.livro)
        throw new ErroCarga(`${nome}: versículo de outro livro (${v.chave})`);
    }
    // O marcador de cada versículo vem da linha `\v` do arquivo, na mesma ordem do interpretador.
    const doArquivo = [...texto.matchAll(RE_LINHA_V)].map((m) => m[1] as string);
    if (doArquivo.length !== vs.length)
      throw new ErroCarga(`${nome}: ${doArquivo.length} marcadores \\v e ${vs.length} versículos`);
    vs.forEach((v, i) => {
      const marcador = doArquivo[i] as string;
      const [prefixo, cap, ver] = marcador.split(".");
      const livro = mapa.get(prefixo ?? "");
      if (livro === undefined || livro * 1_000_000 + Number(cap) * 1_000 + Number(ver) !== v.chave)
        throw new ErroCarga(`${nome}: o marcador ${marcador} não dá a chave ${v.chave}`);
      marcadores.set(v.chave, marcador);
    });
    versiculos.push(...vs);
  }
  if (aplicadas !== listadas)
    throw new ErroCarga(`${aplicadas} correções aplicadas, o registro lista ${listadas}`);
  if (
    completa &&
    listadas !== registro.correcoes_marcacao.filter((c) => c.edicao === edicao).length
  )
    throw new ErroCarga("correções do registro não aplicadas por inteiro");

  // A mesma validação do `ingest:verify`: completa para a edição inteira, parcial para um trecho.
  // Num trecho, só valem as exceções e os "sem texto" dos livros que estão nele.
  const livrosLidos = new Set(escolhidas.map((l) => l.livro));
  const doTrecho = (referencia: string): boolean => {
    const r = parsearReferencia(referencia)[0];
    return r !== undefined && livrosLidos.has(decompor(r.inicio).livro);
  };
  const esperado = completa
    ? registro.esperado
    : {
        ...registro.esperado,
        excecoes: registro.esperado.excecoes.filter((e) => doTrecho(e.referencia)),
        sem_texto: (registro.esperado.sem_texto ?? []).filter((e) => doTrecho(e.referencia)),
      };
  validarEdicao(versiculos, esperado, edicao, !completa);

  const livros = [...new Set(escolhidas.map((l) => l.livro))].sort((a, b) => a - b);
  return {
    edicao,
    versiculos,
    marcadores,
    mesclados: mescladosDoRegistro(registro, tabela, new Set(livros)),
    livros,
    completa,
  };
}

export type LeituraCompleta = {
  edicoes: EdicaoLida[];
  /** Mesma fórmula do `ingest:verify --impressao`: prova que a carga recebe exatamente o que a verificação viu. */
  impressao: string;
  registro: Registro;
  sha256Lock: string;
};

/** sha256 do arquivo de lock: o selo do conjunto de arquivos que a carga leu. */
export async function shaDoLock(): Promise<string> {
  return sha256(new Uint8Array(await readFile(CAMINHO_LOCK)));
}

export async function lerEdicoesVerificadas(): Promise<LeituraCompleta> {
  const registro = await lerRegistro();
  const edicoes: EdicaoLida[] = [];
  const hash = createHash("sha256");
  for (const e of EDICOES) {
    const lida = await lerEdicaoVerificada(e);
    edicoes.push(lida);
    hash.update(JSON.stringify([e, lida.versiculos]));
  }
  const [a, b] = edicoes;
  if (
    !a ||
    !b ||
    a.versiculos.length !== b.versiculos.length ||
    a.versiculos.some((v, i) => v.chave !== b.versiculos[i]?.chave)
  )
    throw new ErroCarga("as duas edições não têm o mesmo conjunto de ids");
  const sha256Lock = await shaDoLock();
  return { edicoes, impressao: hash.digest("hex"), registro, sha256Lock };
}

// ───────────────────────── carga no banco ─────────────────────────

export type ConjuntoCarga = {
  id: string;
  nome: string;
  versao: string;
  commit: string;
  licenca: string;
  urlLicenca: string;
  sha256Lock: string;
  edicaoExibida: Edicao | null;
};

export function conjuntoDoRegistro(registro: Registro, sha256Lock: string): ConjuntoCarga {
  const r = registro as Record<string, unknown>;
  const texto = (campo: string): string => {
    const v = r[campo];
    if (typeof v !== "string" || v === "") throw new ErroCarga(`datasets.yaml sem ${campo}`);
    return v;
  };
  const exibida = r.edicao_exibida;
  if (exibida !== null && exibida !== undefined && exibida !== "n4" && exibida !== "tr")
    throw new ErroCarga("edicao_exibida no registro tem de ser n4, tr ou nulo");
  return {
    id: CONJUNTO_ID,
    nome: texto("nome"),
    versao: texto("data_versao"),
    commit: registro.commit,
    licenca: texto("licenca"),
    urlLicenca: texto("url_licenca"),
    sha256Lock,
    edicaoExibida: exibida ?? null,
  };
}

export type OpcoesEdicao = {
  edicao: Edicao;
  textoId?: string;
  conjunto: ConjuntoCarga;
  marcadores: ReadonlyMap<number, string>;
  mesclados?: readonly Mesclado[];
  /** Carga da edição inteira: o total de versículos esperado; qualquer outro número aborta antes de escrever. */
  totalEsperado?: number;
  cliente?: pg.Client;
};

export type ResultadoCarga = { inseridos: number; alterados: number; inalterados: number };

// Conexão como jnf_carga pelo host direto (transação longa; o agrupador não é necessário).
export async function abrirCarga(): Promise<pg.Client> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  try {
    await cliente.connect();
  } catch (erro) {
    await cliente.end().catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
  return cliente;
}

export const hashDoVersiculo = (v: Versiculo): string =>
  createHash("sha256")
    .update(JSON.stringify([v.texto, v.adicionados, v.notas, v.refs, v.titulo, v.duvidoso]))
    .digest("hex");

function lotes<T>(itens: readonly T[]): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += LOTE_DE_LINHAS)
    saida.push(itens.slice(i, i + LOTE_DE_LINHAS));
  return saida;
}

async function escreverEdicao(
  c: pg.Client,
  versiculos: readonly Versiculo[],
  o: OpcoesEdicao,
): Promise<ResultadoCarga> {
  const textoId = o.textoId ?? textoIdDe(o.edicao);
  const mesclados = o.mesclados ?? [];

  // ── tudo o que pode ser conferido sem tocar o banco ──
  const chaves = new Set<number>();
  let anterior = 0;
  for (const v of versiculos) {
    if (chaves.has(v.chave)) throw new ErroCarga(`chave repetida na entrada: ${v.chave}`);
    if (v.chave <= anterior) throw new ErroCarga(`entrada fora de ordem na chave ${v.chave}`);
    anterior = v.chave;
    chaves.add(v.chave);
    decompor(v.chave);
    if (!o.marcadores.get(v.chave)) throw new ErroCarga(`sem marcador do arquivo para ${v.chave}`);
  }
  for (const m of mesclados) {
    if (chaves.has(m.chave))
      throw new ErroCarga(`o versículo mesclado ${m.refExterna} tem texto próprio na entrada`);
  }
  if (o.totalEsperado !== undefined && versiculos.length !== o.totalEsperado)
    throw new ErroCarga(
      `a entrada tem ${versiculos.length} versículos, o esperado é ${o.totalEsperado}: nada foi escrito`,
    );
  const livrosEntrada = new Map<number, number>();
  for (const v of versiculos) {
    const l = decompor(v.chave).livro;
    livrosEntrada.set(l, (livrosEntrada.get(l) ?? 0) + 1);
  }

  await c.query("begin");
  try {
    // Só uma carga de texto por vez; a trava some no fim da transação.
    // A espera pela trava tem prazo: outra carga presa (ou abandonada) vira erro em 2 minutos, não uma
    // espera sem fim. O prazo vale só para pegar a trava; depois volta ao normal.
    await c.query("set local lock_timeout = '120s'");
    await c.query("select pg_advisory_xact_lock(hashtext('jnf-carga-texto'))");
    await c.query("set local lock_timeout = 0");
    const amb = await c.query<{ nome: string }>("select nome from acervo.ambiente");
    if (amb.rows.length !== 1 || !amb.rows[0])
      throw new ErroCarga("marcador de ambiente ausente no banco: rode as migrações");
    decidirAmbiente(amb.rows[0].nome, process.env.VERCEL_ENV);

    // ── estado atual desta edição, lido antes de qualquer escrita ──
    const atual = await c.query<{ versiculo_id: number; conteudo_hash: string }>(
      "select versiculo_id, conteudo_hash from acervo.texto_versiculo where texto_id = $1",
      [textoId],
    );
    const existentes = new Map(atual.rows.map((r) => [r.versiculo_id, r.conteudo_hash]));
    if (o.totalEsperado !== undefined && existentes.size > o.totalEsperado)
      throw new ErroCarga(
        `o banco já tem ${existentes.size} linhas de ${textoId}, mais que as ${o.totalEsperado} esperadas: nada foi escrito`,
      );
    // Linha existente, de um livro desta carga, que a entrada não conhece: a carga não apaga, então para.
    for (const id of existentes.keys()) {
      if (livrosEntrada.has(decompor(id).livro) && !chaves.has(id))
        throw new ErroCarga(
          `o banco tem uma linha de ${textoId} que a entrada não tem (chave ${id}): nada foi escrito`,
        );
    }

    const novos: Versiculo[] = [];
    const mudados: Versiculo[] = [];
    let inalterados = 0;
    for (const v of versiculos) {
      const h = existentes.get(v.chave);
      if (h === undefined) novos.push(v);
      else if (h !== hashDoVersiculo(v)) mudados.push(v);
      else inalterados++;
    }

    // ── escritas: só inserir ou atualizar o que esta carga é dona ──
    const cj = o.conjunto;
    await c.query(
      `insert into acervo.conjunto_dados (id, nome, versao, commit, licenca, url_licenca, sha256_lock, edicao_exibida)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set nome = excluded.nome, versao = excluded.versao,
         commit = excluded.commit, licenca = excluded.licenca, url_licenca = excluded.url_licenca,
         sha256_lock = excluded.sha256_lock, edicao_exibida = excluded.edicao_exibida
       where (conjunto_dados.nome, conjunto_dados.versao, conjunto_dados.commit, conjunto_dados.licenca,
              conjunto_dados.url_licenca, conjunto_dados.sha256_lock, conjunto_dados.edicao_exibida)
         is distinct from (excluded.nome, excluded.versao, excluded.commit, excluded.licenca,
              excluded.url_licenca, excluded.sha256_lock, excluded.edicao_exibida)`,
      [
        cj.id,
        cj.nome,
        cj.versao,
        cj.commit,
        cj.licenca,
        cj.urlLicenca,
        cj.sha256Lock,
        cj.edicaoExibida,
      ],
    );

    const tabela = carregarTabela();
    for (const l of tabela) {
      const livro = LIVROS[l.livro - 1];
      if (!livro || livro.nome !== l.nome)
        throw new ErroCarga(`o livro ${l.livro} da tabela não bate com a lista de livros`);
    }
    await c.query(
      `insert into acervo.livro (numero, nome, abreviacao, capitulos)
       select * from unnest($1::int2[], $2::text[], $3::text[], $4::int2[])
       on conflict (numero) do update set nome = excluded.nome, abreviacao = excluded.abreviacao,
         capitulos = excluded.capitulos
       where (livro.nome, livro.abreviacao, livro.capitulos)
         is distinct from (excluded.nome, excluded.abreviacao, excluded.capitulos)`,
      [
        LIVROS.map((l) => l.numero),
        LIVROS.map((l) => l.nome),
        LIVROS.map((l) => l.abreviacoes[0] ?? l.nome),
        LIVROS.map((l) => l.capitulos),
      ],
    );

    const idsDeChave = [...chaves, ...mesclados.map((m) => m.chave)].sort((a, b) => a - b);
    for (const lote of lotes(idsDeChave)) {
      const pos = lote.map((k) => decompor(k));
      await c.query(
        `insert into acervo.versiculo (id, livro, capitulo, numero)
         select * from unnest($1::int4[], $2::int2[], $3::int2[], $4::int2[])
         on conflict (id) do nothing`,
        [lote, pos.map((p) => p.livro), pos.map((p) => p.capitulo), pos.map((p) => p.versiculo)],
      );
    }

    await c.query(
      `insert into acervo.texto (id, conjunto_id, edicao, nome) values ($1, $2, $3, $4)
       on conflict (id) do update set conjunto_id = excluded.conjunto_id, edicao = excluded.edicao,
         nome = excluded.nome
       where (texto.conjunto_id, texto.edicao, texto.nome)
         is distinct from (excluded.conjunto_id, excluded.edicao, excluded.nome)`,
      [textoId, cj.id, o.edicao, NOME_DO_TEXTO[o.edicao]],
    );

    for (const lote of lotes([...novos, ...mudados])) {
      await c.query(
        `insert into acervo.texto_versiculo
           (texto_id, versiculo_id, conteudo, adicionados, notas, refs, titulo, duvidoso, conteudo_hash)
         select $1, v.id, v.conteudo, v.adicionados::jsonb, v.notas::jsonb, v.refs::jsonb, v.titulo,
                v.duvidoso, v.hash
         from unnest($2::int4[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                     $8::bool[], $9::text[])
              as v(id, conteudo, adicionados, notas, refs, titulo, duvidoso, hash)
         on conflict (texto_id, versiculo_id) do update set conteudo = excluded.conteudo,
           adicionados = excluded.adicionados, notas = excluded.notas, refs = excluded.refs,
           titulo = excluded.titulo, duvidoso = excluded.duvidoso, conteudo_hash = excluded.conteudo_hash
         where texto_versiculo.conteudo_hash is distinct from excluded.conteudo_hash`,
        [
          textoId,
          lote.map((v) => v.chave),
          lote.map((v) => v.texto),
          lote.map((v) => JSON.stringify(v.adicionados)),
          lote.map((v) => JSON.stringify(v.notas)),
          lote.map((v) => JSON.stringify(v.refs)),
          lote.map((v) => v.titulo),
          lote.map((v) => v.duvidoso),
          lote.map(hashDoVersiculo),
        ],
      );
    }

    // Correspondência: um marcador do arquivo-fonte por versículo, mais os mesclados.
    const linhasCorrespondencia = [
      ...versiculos.map((v) => ({
        ref: o.marcadores.get(v.chave) as string,
        chave: v.chave,
        obs: null as string | null,
      })),
      ...mesclados.map((m) => ({ ref: m.refExterna, chave: m.chave, obs: m.observacao })),
    ];
    for (const lote of lotes(linhasCorrespondencia)) {
      await c.query(
        `insert into acervo.correspondencia_versificacao (conjunto_id, ref_externa, versiculo_id, observacao)
         select $1, x.ref, x.chave, x.obs
         from unnest($2::text[], $3::int4[], $4::text[]) as x(ref, chave, obs)
         on conflict (conjunto_id, ref_externa) do update set versiculo_id = excluded.versiculo_id,
           observacao = excluded.observacao
         where (correspondencia_versificacao.versiculo_id, correspondencia_versificacao.observacao)
           is distinct from (excluded.versiculo_id, excluded.observacao)`,
        [cj.id, lote.map((x) => x.ref), lote.map((x) => x.chave), lote.map((x) => x.obs)],
      );
    }

    // ── conferência final, ainda dentro da transação: contagem por livro igual à da entrada ──
    const noBanco = await c.query<{ livro: number; n: number }>(
      `select v.livro::int as livro, count(*)::int as n
       from acervo.texto_versiculo tv join acervo.versiculo v on v.id = tv.versiculo_id
       where tv.texto_id = $1 group by v.livro order by v.livro`,
      [textoId],
    );
    const contagem = new Map(noBanco.rows.map((r) => [r.livro, r.n]));
    for (const [livro, n] of livrosEntrada) {
      if (contagem.get(livro) !== n)
        throw new ErroCarga(
          `${textoId}, livro ${livro}: ${contagem.get(livro) ?? 0} versículos no banco, ${n} na entrada: desfeito`,
        );
    }
    if (o.totalEsperado !== undefined) {
      const total = noBanco.rows.reduce((s, r) => s + r.n, 0);
      if (total !== o.totalEsperado || contagem.size !== livrosEntrada.size)
        throw new ErroCarga(
          `${textoId}: ${total} versículos no banco, esperados ${o.totalEsperado}: desfeito`,
        );
    }

    await c.query("commit");
    return { inseridos: novos.length, alterados: mudados.length, inalterados };
  } catch (erro) {
    await c.query("rollback").catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
}

/** Carrega uma edição (ou um trecho dela) numa transação como jnf_carga. Nunca apaga linha. */
export async function carregarEdicao(
  versiculos: readonly Versiculo[],
  opcoes: OpcoesEdicao,
): Promise<ResultadoCarga> {
  const proprio = opcoes.cliente === undefined;
  const cliente = opcoes.cliente ?? (await abrirCarga());
  try {
    return await escreverEdicao(cliente, versiculos, opcoes);
  } finally {
    if (proprio) await cliente.end().catch(() => {});
  }
}
