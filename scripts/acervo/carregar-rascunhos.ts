// Carga dos RASCUNHOS de ficha no banco como jnf_carga (ACER-03, D-03, D-17). Este comando só sabe gravar
// rascunho: o contrato da ficha não tem campo de verificação, o papel de carga não tem privilégio de escrita nas
// tabelas de evidência e nada aqui as nomeia. Quem verifica é um Admin com segundo fator, pelas funções do banco.
//
// A pasta das fichas é SEMPRE parâmetro (`--fichas <pasta>` ou ACERVO_FICHAS_DIR) e não há pasta padrão: um padrão
// dentro do produto convidaria a versionar rascunho no repositório público (D-17). Uma transação só, trava
// consultiva da carga do Acervo, idempotente por slug.
//
// `--propostas <pasta>` (ou ACERVO_PROPOSTAS_DIR) carrega as PROPOSTAS de Grau e de Citação das Afirmações dos Estudos
// (plano 02-20, D-04): `acervo.proposta_grau` e as Citações como linhas que NINGUÉM vê até o dono aprovar (a política
// de linha da 0028 só devolve Citação com aprovação valendo, ao Admin com segundo fator, à lista dele). Mesma regra da
// pasta de fichas: sempre parâmetro, nunca padrão (D-17), porque as propostas moram no planejamento privado.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { decidirAmbiente } from "../../src/db/ambiente";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { registrarErro } from "../../src/lib/registro";
import { hashDaFicha, hashDoItem, itensDaFicha } from "../../src/modules/acervo/hash-ficha";
import {
  ErroContrato,
  type FichaYaml,
  interpretarFichaYaml,
  interpretarPagina,
  normalizarEspaco,
  type PropostaYaml,
} from "../../src/modules/acervo/schemas";
import { parsearReferencia } from "../../src/modules/referencias";
import { abrirCarga, ErroCarga } from "../ingest/carregar-biblia";
import { descreverErro, lerPastaDePropostas } from "./propostas";

export type ResultadoRascunhos = {
  fichas: number;
  inseridas: number;
  atualizadas: number;
  inalteradas: number;
  removidas: number;
};

type LinhaFonte = {
  id: string;
  titulo: string;
  autor: string | null;
  idioma: string;
  limites_pt: string | null;
  tipo_texto: string;
  origem_registro: string;
};

type LinhaFicha = {
  edicao_consultada: string;
  ano: number | null;
  editora: string | null;
  tese_pt: string;
  origem_do_rascunho: string;
  idioma_trechos: string;
  conteudo_hash: string;
};

type LinhaItem = {
  id: string;
  tipo: string;
  ordem: number;
  texto_pt: string;
  pagina_inicio: number | null;
  pagina_fim: number | null;
  pagina_texto: string | null;
  trecho_original: string | null;
  idioma_trecho: string | null;
  confianca: string;
  conteudo_hash: string;
};

type Contagem = { inseridas: number; atualizadas: number; inalteradas: number; removidas: number };

const n = <T>(v: T | null | undefined): T | null => v ?? null;
const iguais = (a: readonly unknown[], b: readonly unknown[]) => a.every((v, i) => v === b[i]);

export async function carregarRascunhos(
  fichas: readonly FichaYaml[],
  opcoes: { cliente: pg.Client },
): Promise<ResultadoRascunhos> {
  const c = opcoes.cliente;
  const total: Contagem = { inseridas: 0, atualizadas: 0, inalteradas: 0, removidas: 0 };
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

    for (const ficha of fichas) await carregarUma(c, ficha, total);
    await c.query("commit");
  } catch (erro) {
    await c.query("rollback").catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
  return { fichas: fichas.length, ...total };
}

async function carregarUma(c: pg.Client, ficha: FichaYaml, total: Contagem): Promise<void> {
  const itens = itensDaFicha(ficha);
  const hashFicha = hashDaFicha(ficha, itens);

  // ───── a Fonte da ficha: só se cria ou se atualiza Fonte que JÁ é de ficha; nunca se toca outra.
  const existente = (
    await c.query<LinhaFonte>(
      `select id, titulo, autor, idioma, limites_pt, tipo_texto, origem_registro
         from acervo.fonte where slug = $1`,
      [ficha.slug],
    )
  ).rows[0];
  if (existente && existente.tipo_texto !== "ficha")
    throw new ErroCarga(`Fonte ${ficha.slug}: não é de ficha e a carga de rascunhos nunca a toca`);
  if (existente?.origem_registro === "painel")
    throw new ErroCarga(`Fonte ${ficha.slug}: foi criada pelo painel e a carga nunca a toca`);

  const valoresFonte = [ficha.titulo, ficha.autor, ficha.idioma_trechos, n(ficha.limites_pt)];
  let fonteId: string;
  if (!existente) {
    // `publicada` fica falso e nunca é gravado de novo por aqui: publicar é decisão do Admin.
    const novo = await c.query<{ id: string }>(
      `insert into acervo.fonte (slug, titulo, autor, idioma, limites_pt, nivel, tipo_texto, obra_protegida, publicada)
       values ($5, $1, $2, $3, $4, 'academica', 'ficha', true, false) returning id`,
      [...valoresFonte, ficha.slug],
    );
    fonteId = (novo.rows[0] as { id: string }).id;
    total.inseridas++;
  } else {
    fonteId = existente.id;
    const atuais = [existente.titulo, existente.autor, existente.idioma, existente.limites_pt];
    if (iguais(atuais, valoresFonte)) {
      total.inalteradas++;
    } else {
      await c.query(
        "update acervo.fonte set titulo = $1, autor = $2, idioma = $3, limites_pt = $4 where id = $5",
        [...valoresFonte, fonteId],
      );
      total.atualizadas++;
    }
  }

  // ───── a ficha
  const valoresFicha = [
    ficha.edicao_consultada,
    ficha.ano,
    n(ficha.editora),
    ficha.tese_pt,
    ficha.origem_do_rascunho,
    ficha.idioma_trechos,
    hashFicha,
  ];
  const fichaAtual = (
    await c.query<LinhaFicha>(
      `select edicao_consultada, ano, editora, tese_pt, origem_do_rascunho, idioma_trechos, conteudo_hash
         from acervo.ficha where fonte_id = $1`,
      [fonteId],
    )
  ).rows[0];
  if (!fichaAtual) {
    await c.query(
      `insert into acervo.ficha (fonte_id, edicao_consultada, ano, editora, tese_pt, origem_do_rascunho,
         idioma_trechos, conteudo_hash)
       values ($8, $1, $2, $3, $4, $5, $6, $7)`,
      [...valoresFicha, fonteId],
    );
    total.inseridas++;
  } else if (
    iguais(
      [
        fichaAtual.edicao_consultada,
        fichaAtual.ano,
        fichaAtual.editora,
        fichaAtual.tese_pt,
        fichaAtual.origem_do_rascunho,
        fichaAtual.idioma_trechos,
        fichaAtual.conteudo_hash,
      ],
      valoresFicha,
    )
  ) {
    total.inalteradas++;
  } else {
    await c.query(
      `update acervo.ficha set edicao_consultada = $1, ano = $2, editora = $3, tese_pt = $4,
         origem_do_rascunho = $5, idioma_trechos = $6, conteudo_hash = $7, atualizado_em = now()
       where fonte_id = $8`,
      [...valoresFicha, fonteId],
    );
    total.atualizadas++;
  }

  // ───── os itens: o que saiu do YAML é apagado (e a conferência vai junto, em cascata)
  // O hash que vale é o que o BANCO calcula (0018): o valor enviado acima é só o esperado e é sobrescrito.
  const atuais = new Map(
    (
      await c.query<LinhaItem>(
        `select id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim, pagina_texto, trecho_original,
                idioma_trecho, confianca, conteudo_hash
           from acervo.ficha_item where ficha_id = $1`,
        [fonteId],
      )
    ).rows.map((r) => [r.id, r]),
  );
  const queFicam = new Set(itens.map((i) => i.id));
  const saem = [...atuais.keys()].filter((id) => !queFicam.has(id));
  if (saem.length > 0) {
    await c.query("delete from acervo.ficha_item where id = any($1::text[])", [saem]);
    total.removidas += saem.length;
  }

  for (const item of itens) {
    const valores = [
      item.tipo,
      item.ordem,
      item.texto_pt,
      item.pagina.inicio,
      item.pagina.fim,
      item.pagina.texto,
      item.trecho_original,
      item.idioma_trecho,
      item.confianca,
      hashDoItem(item),
    ];
    const a = atuais.get(item.id);
    if (!a) {
      await c.query(
        `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim,
           pagina_texto, trecho_original, idioma_trecho, confianca, conteudo_hash)
         values ($11, $12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [...valores, item.id, fonteId],
      );
      total.inseridas++;
    } else if (
      iguais(
        [
          a.tipo,
          a.ordem,
          a.texto_pt,
          a.pagina_inicio,
          a.pagina_fim,
          a.pagina_texto,
          a.trecho_original,
          a.idioma_trecho,
          a.confianca,
          a.conteudo_hash,
        ],
        valores,
      )
    ) {
      total.inalteradas++;
    } else {
      await c.query(
        `update acervo.ficha_item set tipo = $1, ordem = $2, texto_pt = $3, pagina_inicio = $4, pagina_fim = $5,
           pagina_texto = $6, trecho_original = $7, idioma_trecho = $8, confianca = $9, conteudo_hash = $10
         where id = $11`,
        [...valores, item.id],
      );
      total.atualizadas++;
    }
  }

  // O banco é quem calcula o hash da ficha (0018). Se o formato dele divergir do canônico deste código, a carga para
  // aqui, alto, em vez de gravar uma ficha que nunca bate com o que o TypeScript espera.
  const gravado = (
    await c.query<{ conteudo_hash: string }>(
      "select conteudo_hash from acervo.ficha where fonte_id = $1",
      [fonteId],
    )
  ).rows[0]?.conteudo_hash;
  if (gravado !== hashFicha)
    throw new ErroCarga(
      `ficha ${ficha.slug}: o hash calculado pelo banco difere do canônico (rode as migrações ou corrija o formato)`,
    );
}

// ───────────────────────── propostas de Grau e de Citação ─────────────────────────

export type ResultadoPropostas = {
  propostas: number;
  /** Linhas novas: `proposta_grau` e Citações. */
  inseridas: number;
  /** `proposta_grau` que mudou (grau, justificativa ou o hash do texto). */
  atualizadas: number;
  inalteradas: number;
  /** Citações de uma Afirmação cujo conjunto mudou: saem as velhas e entram as novas (contadas em `inseridas`). */
  removidas: number;
  /** Afirmações com aprovação gravada: a carga NÃO as toca (T-02-56). */
  jaAprovadas: string[];
  semCitacao: number;
};

type AlvoDeCitacao = {
  paragrafo: string | null;
  item: string | null;
  inicio: number | null;
  fim: number | null;
  trecho: string | null;
  idioma: string | null;
};

type LinhaDeCitacao = {
  ordem: number;
  fonte_paragrafo_id: string | null;
  ficha_item_id: string | null;
  versiculo_inicio: number | null;
  versiculo_fim: number | null;
  trecho: string | null;
  idioma: string | null;
};

const mesmoAlvo = (a: AlvoDeCitacao, l: LinhaDeCitacao): boolean =>
  a.paragrafo === l.fonte_paragrafo_id &&
  a.item === l.ficha_item_id &&
  a.inicio === l.versiculo_inicio &&
  a.fim === l.versiculo_fim &&
  a.trecho === l.trecho &&
  a.idioma === l.idioma;

/**
 * Resolve cada Citação proposta contra o BANCO, dentro da transação: o alvo existe, o trecho do parágrafo é literal do
 * texto que está lá e a ficha traz a página citada. Erro nomeia só ids (públicos), nunca o trecho proposto.
 */
async function resolverCitacoes(c: pg.Client, p: PropostaYaml): Promise<AlvoDeCitacao[]> {
  const alvos: AlvoDeCitacao[] = [];
  for (const [i, ct] of p.citacoes.entries()) {
    const onde = `proposta ${p.afirmacao}, Citação ${i + 1}`;
    if (ct.alvo === "paragrafo") {
      const id = `${ct.fonte}/${ct.ref}`;
      const linha = (
        await c.query<{ texto: string }>("select texto from acervo.fonte_paragrafo where id = $1", [
          id,
        ])
      ).rows[0];
      if (!linha) throw new ErroCarga(`${onde}: o parágrafo ${id} não existe no banco`);
      if (!normalizarEspaco(linha.texto).includes(normalizarEspaco(ct.trecho)))
        throw new ErroCarga(`${onde}: o trecho não é cópia literal do parágrafo ${id}`);
      // O idioma fica nulo de propósito: a leitura herda o do parágrafo e o da Fonte.
      alvos.push({
        paragrafo: id,
        item: null,
        inicio: null,
        fim: null,
        trecho: normalizarEspaco(ct.trecho),
        idioma: null,
      });
    } else if (ct.alvo === "ficha") {
      const id = `${ct.ficha}/${ct.item}`;
      const linha = (
        await c.query<{
          pagina_inicio: number | null;
          pagina_fim: number | null;
          pagina_texto: string | null;
          trecho_original: string | null;
        }>(
          "select pagina_inicio, pagina_fim, pagina_texto, trecho_original from acervo.ficha_item where id = $1",
          [id],
        )
      ).rows[0];
      if (!linha) throw new ErroCarga(`${onde}: o item de ficha ${id} não existe no banco`);
      const pagina = interpretarPagina(ct.pagina);
      if (
        pagina.inicio !== linha.pagina_inicio ||
        pagina.fim !== linha.pagina_fim ||
        pagina.texto !== linha.pagina_texto
      )
        throw new ErroCarga(`${onde}: a página citada difere da que a ficha traz para ${id}`);
      let trecho: string | null = null;
      if (ct.trecho != null) {
        if (linha.trecho_original === null)
          throw new ErroCarga(`${onde}: o item ${id} não tem trecho original para citar`);
        if (!normalizarEspaco(linha.trecho_original).includes(normalizarEspaco(ct.trecho)))
          throw new ErroCarga(`${onde}: o trecho não é literal do original do item ${id}`);
        trecho = normalizarEspaco(ct.trecho);
      }
      // Idioma nulo: a leitura herda o do item da ficha.
      alvos.push({ paragrafo: null, item: id, inicio: null, fim: null, trecho, idioma: null });
    } else {
      let intervalos: { inicio: number; fim: number }[];
      try {
        intervalos = parsearReferencia(ct.referencia);
      } catch {
        throw new ErroCarga(`${onde}: referência de Passagem inválida`);
      }
      const intervalo = intervalos[0];
      if (intervalos.length !== 1 || !intervalo)
        throw new ErroCarga(`${onde}: a Passagem deve ser um intervalo contínuo só`);
      const chaves = [...new Set([intervalo.inicio, intervalo.fim])];
      const existem = (
        await c.query<{ id: number }>("select id from acervo.versiculo where id = any($1::int[])", [
          chaves,
        ])
      ).rows.map((r) => r.id);
      const falta = chaves.find((k) => !existem.includes(k));
      if (falta !== undefined)
        throw new ErroCarga(`${onde}: o versículo ${falta} não existe no banco`);
      alvos.push({
        paragrafo: null,
        item: null,
        inicio: intervalo.inicio,
        fim: intervalo.fim,
        trecho: null,
        idioma: null,
      });
    }
  }
  return alvos;
}

/**
 * Carga das propostas numa transação só (TUDO OU NADA: uma entrada ruim numa Afirmação não aprovada desfaz o lote
 * inteiro, em voz alta; a Afirmação APROVADA é pulada logo depois da trava, antes de qualquer conferência, e nunca
 * faz o lote falhar, nem com o texto da proposta divergente), com a trava da carga do Acervo. Para cada Afirmação
 * (por id, em ordem fixa): trava a linha (`for update`, o mesmo que `aprovar_afirmacao` faz), PULA a que já tem
 * aprovação gravada, confere que o texto do banco é o da proposta, grava `proposta_grau` com o `texto_hash` lido do banco e troca o conjunto de
 * Citações só quando ele mudou. Qualquer erro desfaz tudo.
 */
export async function carregarPropostas(
  propostas: readonly PropostaYaml[],
  opcoes: { cliente: pg.Client },
): Promise<ResultadoPropostas> {
  const c = opcoes.cliente;
  const vistos = new Set<string>();
  for (const p of propostas) {
    if (vistos.has(p.afirmacao)) throw new ErroCarga(`proposta repetida: ${p.afirmacao}`);
    vistos.add(p.afirmacao);
  }
  const r: ResultadoPropostas = {
    propostas: propostas.length,
    inseridas: 0,
    atualizadas: 0,
    inalteradas: 0,
    removidas: 0,
    jaAprovadas: [],
    semCitacao: 0,
  };
  const ordenadas = [...propostas].sort((a, b) => a.afirmacao.localeCompare(b.afirmacao));

  await c.query("begin");
  try {
    await c.query("set local lock_timeout = '120s'");
    await c.query("select pg_advisory_xact_lock(hashtext('jnf-carga-acervo'))");
    await c.query("set local lock_timeout = 0");
    const amb = await c.query<{ nome: string }>("select nome from acervo.ambiente");
    if (amb.rows.length !== 1 || !amb.rows[0])
      throw new ErroCarga("marcador de ambiente ausente no banco: rode as migrações");
    decidirAmbiente(amb.rows[0].nome, process.env.VERCEL_ENV);

    for (const p of ordenadas) {
      // A mesma trava de `aprovar_afirmacao`: aprovação e carga da mesma Afirmação se serializam.
      const af = (
        await c.query<{ texto: string; texto_hash: string }>(
          "select texto, texto_hash from acervo.afirmacao where id = $1 for update",
          [p.afirmacao],
        )
      ).rows[0];
      if (!af)
        throw new ErroCarga(
          `proposta ${p.afirmacao}: a Afirmação não existe no banco (carregue o conteúdo dos Estudos antes)`,
        );
      const aprovada = await c.query(
        "select 1 from acervo.aprovacao_afirmacao where afirmacao_id = $1",
        [p.afirmacao],
      );
      if ((aprovada.rowCount ?? 0) > 0) {
        r.jaAprovadas.push(p.afirmacao);
        continue;
      }
      // Só a Afirmação NÃO aprovada tem o texto conferido (e uma proposta divergente falha em voz alta, desfazendo o lote).
      if (normalizarEspaco(af.texto) !== normalizarEspaco(p.texto))
        throw new ErroCarga(
          `proposta ${p.afirmacao}: o texto da Afirmação no banco difere do da proposta`,
        );

      // ───── a proposta de Grau
      const justificativa = p.justificativa.trim();
      const atual = (
        await c.query<{ grau_proposto: string; justificativa: string; texto_hash: string }>(
          "select grau_proposto, justificativa, texto_hash from acervo.proposta_grau where afirmacao_id = $1",
          [p.afirmacao],
        )
      ).rows[0];
      if (!atual) {
        await c.query(
          `insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash)
           values ($1, $2, $3, $4)`,
          [p.afirmacao, p.grau_proposto, justificativa, af.texto_hash],
        );
        r.inseridas++;
      } else if (
        atual.grau_proposto === p.grau_proposto &&
        atual.justificativa === justificativa &&
        atual.texto_hash === af.texto_hash
      ) {
        r.inalteradas++;
      } else {
        await c.query(
          `update acervo.proposta_grau set grau_proposto = $2, justificativa = $3, texto_hash = $4,
             proposta_em = now() where afirmacao_id = $1`,
          [p.afirmacao, p.grau_proposto, justificativa, af.texto_hash],
        );
        r.atualizadas++;
      }

      // ───── as Citações: o conjunto inteiro da proposta, na ordem da lista
      const alvos = await resolverCitacoes(c, p);
      if (p.sem_citacao) r.semCitacao++;
      const existentes = (
        await c.query<LinhaDeCitacao>(
          `select ordem, fonte_paragrafo_id, ficha_item_id, versiculo_inicio, versiculo_fim, trecho, idioma
             from acervo.citacao where afirmacao_id = $1 order by ordem`,
          [p.afirmacao],
        )
      ).rows;
      const igual =
        existentes.length === alvos.length &&
        alvos.every((a, i) => {
          const l = existentes[i];
          return l !== undefined && l.ordem === i + 1 && mesmoAlvo(a, l);
        });
      if (igual) {
        r.inalteradas += alvos.length;
        continue;
      }
      if (existentes.length > 0) {
        await c.query("delete from acervo.citacao where afirmacao_id = $1", [p.afirmacao]);
        r.removidas += existentes.length;
      }
      for (const [i, a] of alvos.entries()) {
        await c.query(
          `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, ficha_item_id, versiculo_inicio,
             versiculo_fim, trecho, idioma, ordem)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.afirmacao, a.paragrafo, a.item, a.inicio, a.fim, a.trecho, a.idioma, i + 1],
        );
        r.inseridas++;
      }
    }
    await c.query("commit");
  } catch (erro) {
    await c.query("rollback").catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
  return r;
}

/** Lê e confere o contrato da pasta de propostas, TUDO antes de qualquer conexão. Erro lista cada entrada ruim. */
export function lerPropostasConferidas(pasta: string): PropostaYaml[] {
  const { propostas, erros } = lerPastaDePropostas(pasta);
  if (erros.length > 0)
    throw new ErroContrato(
      `propostas fora do contrato (${erros.length}):\n${erros.map((e) => `  ${descreverErro(e)}`).join("\n")}`,
    );
  if (propostas.length === 0)
    throw new ErroContrato("a pasta de propostas não tem proposta alguma");
  const vistos = new Set<string>();
  for (const p of propostas) {
    if (vistos.has(p.afirmacao)) throw new ErroContrato(`proposta repetida: ${p.afirmacao}`);
    vistos.add(p.afirmacao);
  }
  return propostas;
}

// ───────────────────────── comando: pnpm acervo:rascunhos ─────────────────────────

export type OpcoesDosRascunhos = {
  fichas: string | undefined;
  /** A pasta das propostas de Grau e de Citação (planejamento privado). Sem padrão (D-17). */
  propostas?: string | undefined;
  /** Só confere o contrato de cada YAML: nunca abre conexão com o banco. */
  soValidar?: boolean;
};
export type DependenciasDosRascunhos = {
  /** Abre o cliente `jnf_carga`. Só é chamado depois de TODA conferência passar. */
  abrir?: () => Promise<pg.Client>;
  escrever?: (linha: string) => void;
};

function nomesDosYamls(pasta: string): string[] {
  try {
    return readdirSync(pasta)
      .filter((nome) => nome.endsWith(".yaml"))
      .sort();
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT")
      throw new ErroCarga("a pasta de fichas não existe");
    throw erro;
  }
}

/**
 * Modo `--so-validar`: confere o contrato de CADA YAML (não para na primeira reprovada), imprime `OK <slug>` ou o
 * campo reprovado, e lança se qualquer uma reprovar. Não recebe nem cria cliente de banco.
 */
function validarPasta(pasta: string, escrever: (linha: string) => void): FichaYaml[] {
  const aprovadas: FichaYaml[] = [];
  let reprovadas = 0;
  for (const nome of nomesDosYamls(pasta)) {
    try {
      const ficha = interpretarFichaYaml(readFileSync(path.join(pasta, nome), "utf8"), nome);
      if (aprovadas.some((f) => f.slug === ficha.slug)) {
        reprovadas++;
        escrever(`REPROVADA ${nome}: ficha repetida na pasta: ${ficha.slug}`);
        continue;
      }
      aprovadas.push(ficha);
      escrever(`OK ${ficha.slug}`);
    } catch (erro) {
      if (!(erro instanceof ErroContrato)) throw erro;
      reprovadas++;
      escrever(`REPROVADA ${erro.message}`);
    }
  }
  escrever(
    `fichas=${aprovadas.length} reprovadas=${reprovadas} (só validação: nada foi aberto no banco)`,
  );
  if (reprovadas > 0) throw new ErroCarga(`${reprovadas} ficha(s) reprovada(s) pelo contrato`);
  return aprovadas;
}

function lerYamls(pasta: string): FichaYaml[] {
  const nomes = nomesDosYamls(pasta);
  const fichas = nomes.map((nome) =>
    interpretarFichaYaml(readFileSync(path.join(pasta, nome), "utf8"), nome),
  );
  const vistos = new Set<string>();
  for (const f of fichas) {
    if (vistos.has(f.slug)) throw new ErroCarga(`ficha repetida na pasta: ${f.slug}`);
    vistos.add(f.slug);
  }
  return fichas;
}

/**
 * Confere a pasta e o contrato de cada YAML, TUDO antes de criar o cliente do banco; só então carrega. Erro lança
 * (o comando sai com 1); nada é gravado.
 */
export async function executarRascunhos(
  opcoes: OpcoesDosRascunhos,
  deps: DependenciasDosRascunhos = {},
): Promise<ResultadoRascunhos | null> {
  const escrever = deps.escrever ?? ((l: string) => console.log(l));
  if (!opcoes.fichas && !opcoes.propostas)
    throw new ErroCarga(
      "a pasta de fichas é obrigatória: use --fichas <pasta> ou ACERVO_FICHAS_DIR (não há pasta padrão; D-17). " +
        "Para as propostas de Grau e de Citação: --propostas <pasta> ou ACERVO_PROPOSTAS_DIR",
    );
  // O contrato das propostas se confere ANTES de qualquer carga, inclusive a das fichas: contrato ruim não grava nada.
  const propostas = opcoes.propostas ? lerPropostasConferidas(opcoes.propostas) : null;
  let resultado: ResultadoRascunhos | null = null;

  if (opcoes.fichas) {
    if (opcoes.soValidar) {
      validarPasta(opcoes.fichas, escrever);
    } else {
      const fichas = lerYamls(opcoes.fichas);
      if (fichas.length === 0) {
        escrever("acervo:rascunhos: não há ficha na pasta");
      } else {
        const abrir = deps.abrir ?? abrirCarga;
        const cliente = await abrir();
        try {
          const r = await carregarRascunhos(fichas, { cliente });
          escrever(
            `inseridas=${r.inseridas} atualizadas=${r.atualizadas} inalteradas=${r.inalteradas} removidas=${r.removidas}`,
          );
          escrever(
            `fichas=${r.fichas} (todas como rascunho: nenhuma é verificada por este comando)`,
          );
          resultado = r;
        } finally {
          await cliente.end().catch(() => {});
        }
      }
    }
  }

  if (propostas) {
    if (opcoes.soValidar) {
      escrever(
        `propostas=${propostas.length} (só contrato: nada foi aberto no banco; o validador de máquina é acervo:validar-propostas)`,
      );
    } else {
      const abrir = deps.abrir ?? abrirCarga;
      const cliente = await abrir();
      try {
        const r = await carregarPropostas(propostas, { cliente });
        escrever(
          `propostas: inseridas=${r.inseridas} atualizadas=${r.atualizadas} inalteradas=${r.inalteradas} removidas=${r.removidas} puladas_aprovadas=${r.jaAprovadas.length}`,
        );
        for (const id of r.jaAprovadas) escrever(`já aprovada, não alterada: ${id}`);
        escrever(
          `propostas=${r.propostas} sem_citacao=${r.semCitacao} (invisíveis ao Estudante e ao Assistente até a aprovação do dono)`,
        );
      } finally {
        await cliente.end().catch(() => {});
      }
    }
  }
  return resultado;
}

export function lerOpcoes(
  argumentos: string[],
  env: Record<string, string | undefined>,
): OpcoesDosRascunhos {
  const soValidar = argumentos.includes("--so-validar");
  const valorDe = (nome: string): string | undefined => {
    const i = argumentos.indexOf(nome);
    if (i < 0) return undefined;
    const valor = argumentos[i + 1];
    if (!valor || valor.startsWith("--"))
      throw new ErroCarga(
        "Uso: acervo:rascunhos [--fichas <pasta>] [--propostas <pasta>] [--so-validar]",
      );
    return path.resolve(valor);
  };
  const daEnv = (v: string | undefined) => (v ? path.resolve(v) : undefined);
  return {
    fichas: valorDe("--fichas") ?? daEnv(env.ACERVO_FICHAS_DIR),
    propostas: valorDe("--propostas") ?? daEnv(env.ACERVO_PROPOSTAS_DIR),
    soValidar,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => executarRascunhos(lerOpcoes(process.argv.slice(2), process.env)))
    .then(
      () => process.exit(0),
      (erro) => {
        // Só erro nosso mostra texto; o resto vai só com código e classe (a URL do banco é segredo).
        if (erro instanceof ErroContrato || erro instanceof ErroCarga) console.error(erro.message);
        else registrarErro("acervo-rascunhos", erro);
        process.exit(1);
      },
    );
}
