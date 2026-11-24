// Carga dos RASCUNHOS de ficha no banco como jnf_carga (ACER-03, D-03, D-17). Este comando só sabe gravar
// rascunho: o contrato da ficha não tem campo de verificação, o papel de carga não tem privilégio de escrita nas
// tabelas de evidência e nada aqui as nomeia. Quem verifica é um Admin com segundo fator, pelas funções do banco.
//
// A pasta das fichas é SEMPRE parâmetro (`--fichas <pasta>` ou ACERVO_FICHAS_DIR) e não há pasta padrão: um padrão
// dentro do produto convidaria a versionar rascunho no repositório público (D-17). Uma transação só, trava
// consultiva da carga do Acervo, idempotente por slug.

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
} from "../../src/modules/acervo/schemas";
import { abrirCarga, ErroCarga } from "../ingest/carregar-biblia";

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

// ───────────────────────── comando: pnpm acervo:rascunhos ─────────────────────────

export type OpcoesDosRascunhos = {
  fichas: string | undefined;
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
  if (!opcoes.fichas)
    throw new ErroCarga(
      "a pasta de fichas é obrigatória: use --fichas <pasta> ou ACERVO_FICHAS_DIR (não há pasta padrão; D-17)",
    );
  if (opcoes.soValidar) {
    validarPasta(opcoes.fichas, escrever);
    return null;
  }
  const fichas = lerYamls(opcoes.fichas);
  if (fichas.length === 0) {
    escrever("acervo:rascunhos: não há ficha na pasta");
    return null;
  }
  const abrir = deps.abrir ?? abrirCarga;
  const cliente = await abrir();
  try {
    const r = await carregarRascunhos(fichas, { cliente });
    escrever(
      `inseridas=${r.inseridas} atualizadas=${r.atualizadas} inalteradas=${r.inalteradas} removidas=${r.removidas}`,
    );
    escrever(`fichas=${r.fichas} (todas como rascunho: nenhuma é verificada por este comando)`);
    return r;
  } finally {
    await cliente.end().catch(() => {});
  }
}

export function lerOpcoes(argumentos: string[], env: NodeJS.ProcessEnv): OpcoesDosRascunhos {
  const soValidar = argumentos.includes("--so-validar");
  const i = argumentos.indexOf("--fichas");
  if (i >= 0) {
    const valor = argumentos[i + 1];
    if (!valor || valor.startsWith("--"))
      throw new ErroCarga("Uso: acervo:rascunhos --fichas <pasta> [--so-validar]");
    return { fichas: path.resolve(valor), soValidar };
  }
  const daEnv = env.ACERVO_FICHAS_DIR;
  return { fichas: daEnv ? path.resolve(daEnv) : undefined, soValidar };
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
