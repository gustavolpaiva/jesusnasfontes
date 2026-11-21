// pnpm content:load [--dir <pasta>] — carrega as Trilhas e os Estudos de content/ no banco como jnf_carga.
// Idempotente por slug e conteudo_hash; uma transação só (qualquer erro desfaz tudo); nunca apaga um
// Estudo. Só as Passagens do Estudo que MUDOU são trocadas, escopadas ao id dele.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { decidirAmbiente } from "../../src/db/ambiente";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { registrarErro } from "../../src/lib/registro";
import { abrirCarga, ErroCarga } from "../ingest/carregar-biblia";
import { textoDaAfirmacao } from "./afirmacoes";
import {
  type ConteudoLido,
  conferirContagens,
  ErroConteudo,
  type EstudoLido,
  lerPasta,
} from "./esquema";

export type Contagem = { inseridos: number; atualizados: number; inalterados: number };
export type ResultadoConteudo = {
  estudos: Contagem;
  trilhas: Contagem;
  afirmacoes: Contagem & { removidas: number };
  divergencias: number;
  /** Linhas de `conteudo.pergunta_volta` gravadas nesta carga (0 quando nada mudou). */
  perguntas: number;
};

export const PASTA_PADRAO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "content",
);

export async function carregarConteudo(
  conteudo: ConteudoLido,
  opcoes: { cliente?: pg.Client } = {},
): Promise<ResultadoConteudo> {
  const proprio = opcoes.cliente === undefined;
  const c = opcoes.cliente ?? (await abrirCarga());
  const estudos: Contagem = { inseridos: 0, atualizados: 0, inalterados: 0 };
  const trilhas: Contagem = { inseridos: 0, atualizados: 0, inalterados: 0 };
  const afirmacoes = { inseridos: 0, atualizados: 0, inalterados: 0, removidas: 0 };
  let divergencias = 0;
  let perguntas = 0;
  try {
    await c.query("begin");
    try {
      // A espera pela trava tem prazo: outra carga presa (ou abandonada) vira erro em 2 minutos, não uma
      // espera sem fim. O prazo vale só para pegar a trava; depois volta ao normal.
      await c.query("set local lock_timeout = '120s'");
      await c.query("select pg_advisory_xact_lock(hashtext('jnf-carga-conteudo'))");
      await c.query("set local lock_timeout = 0");
      const amb = await c.query<{ nome: string }>("select nome from acervo.ambiente");
      if (amb.rows.length !== 1 || !amb.rows[0])
        throw new ErroCarga("marcador de ambiente ausente no banco: rode as migrações");
      decidirAmbiente(amb.rows[0].nome, process.env.VERCEL_ENV);

      // Trilhas: upsert por id, só quando algum campo muda.
      const trilhasAtuais = await c.query<{
        id: string;
        nome: string;
        ordem: number;
        descricao: string;
      }>("select id, nome, ordem, descricao from conteudo.trilha");
      const porId = new Map(trilhasAtuais.rows.map((r) => [r.id, r]));
      // Trocar a ordem de duas Trilhas (1 e 2) já carregadas violaria UNIQUE(ordem) no primeiro upsert e desfaria a carga
      // inteira, embora o resultado final fosse válido. As que mudam de ordem saem antes da posição (negativa, única
      // entre si); o upsert grava a definitiva. A posição provisória nunca sobrevive: tudo roda na mesma transação.
      const trilhasQueMudamDeOrdem = conteudo.trilhas
        .filter((t) => {
          const atual = porId.get(t.id);
          return atual !== undefined && atual.ordem !== t.ordem;
        })
        .map((t) => t.id);
      if (trilhasQueMudamDeOrdem.length > 0) {
        await c.query("update conteudo.trilha set ordem = -ordem - 1 where id = any($1::text[])", [
          trilhasQueMudamDeOrdem,
        ]);
      }
      for (const t of conteudo.trilhas) {
        const atual = porId.get(t.id);
        if (!atual) trilhas.inseridos++;
        else if (atual.nome !== t.nome || atual.ordem !== t.ordem || atual.descricao !== t.descricao)
          trilhas.atualizados++;
        else {
          trilhas.inalterados++;
          continue;
        }
        await c.query(
          `insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, $3, $4)
           on conflict (id) do update set nome = excluded.nome, ordem = excluded.ordem,
             descricao = excluded.descricao`,
          [t.id, t.nome, t.ordem, t.descricao],
        );
      }

      // O mesmo para os Estudos: UNIQUE(trilha, ordem) e dois Estudos que trocam de posição (ou um que ocupa a posição de
      // outro que também muda). Só os que serão reescritos e mudam de Trilha ou de ordem saem da posição.
      const posicoes = await c.query<{
        slug: string;
        trilha_id: string;
        ordem: number;
        conteudo_hash: string;
      }>("select slug, trilha_id, ordem, conteudo_hash from conteudo.estudo");
      const posicaoPorSlug = new Map(posicoes.rows.map((r) => [r.slug, r]));
      const estudosQueMudamDePosicao = conteudo.estudos
        .filter((e) => {
          const atual = posicaoPorSlug.get(e.frontMatter.slug);
          return (
            atual !== undefined &&
            atual.conteudo_hash !== e.conteudoHash &&
            (atual.ordem !== e.frontMatter.ordem || atual.trilha_id !== e.frontMatter.trilha)
          );
        })
        .map((e) => e.frontMatter.slug);
      if (estudosQueMudamDePosicao.length > 0) {
        await c.query("update conteudo.estudo set ordem = -ordem - 1 where slug = any($1::text[])", [
          estudosQueMudamDePosicao,
        ]);
      }

      for (const e of conteudo.estudos) {
        const fm = e.frontMatter;
        const existente = await c.query<{ id: string; conteudo_hash: string }>(
          "select id, conteudo_hash from conteudo.estudo where slug = $1",
          [fm.slug],
        );
        const linha = existente.rows[0];
        if (linha && linha.conteudo_hash === e.conteudoHash) {
          estudos.inalterados++;
          await reconciliarAfirmacoes(c, linha.id, e, afirmacoes);
          continue;
        }
        const valores = [
          fm.trilha,
          fm.ordem,
          fm.grupo ?? null,
          fm.titulo,
          fm.recorte,
          fm.minutos ?? null,
          e.corpo,
          fm.grau_de_certeza?.valor ?? null,
          fm.grau_de_certeza?.texto ?? null,
          fm.grau_de_certeza?.revisado ?? false,
          e.conteudoHash,
          e.livro ?? null,
          e.capitulo ?? null,
        ];
        let estudoId: string;
        if (!linha) {
          const novo = await c.query<{ id: string }>(
            `insert into conteudo.estudo (slug, trilha_id, ordem, grupo, titulo, recorte, minutos, corpo_md,
               grau_certeza_valor, grau_certeza_texto, grau_certeza_revisado, conteudo_hash, livro, capitulo)
             values ($14, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
            [...valores, fm.slug],
          );
          estudoId = (novo.rows[0] as { id: string }).id;
          estudos.inseridos++;
        } else {
          estudoId = linha.id;
          await c.query(
            `update conteudo.estudo set trilha_id = $1, ordem = $2, grupo = $3, titulo = $4, recorte = $5,
               minutos = $6, corpo_md = $7, grau_certeza_valor = $8, grau_certeza_texto = $9,
               grau_certeza_revisado = $10, conteudo_hash = $11, livro = $12, capitulo = $13,
               atualizado_em = now()
             where id = $14`,
            [...valores, estudoId],
          );
          // Troca das Passagens do Estudo que mudou, escopada ao id dele e dentro da transação.
          await c.query("delete from conteudo.estudo_passagem where estudo_id = $1", [estudoId]);
          estudos.atualizados++;
        }
        // Divergências do Estudo que mudou: trocadas inteiras, escopadas ao id dele.
        await c.query("delete from conteudo.divergencia where estudo_id = $1", [estudoId]);
        for (const [i, d] of fm.divergencias.entries()) {
          const nova = await c.query<{ id: string }>(
            `insert into conteudo.divergencia (estudo_id, ordem, tema) values ($1, $2, $3) returning id`,
            [estudoId, i + 1, d.tema],
          );
          const divergenciaId = (nova.rows[0] as { id: string }).id;
          for (const l of d.leituras) {
            await c.query(
              `insert into conteudo.divergencia_leitura (divergencia_id, tradicao, resumo) values ($1, $2, $3)`,
              [divergenciaId, l.tradicao, l.resumo],
            );
          }
          divergencias++;
        }
        await reconciliarAfirmacoes(c, estudoId, e, afirmacoes);
        if (e.passagens.length > 0) {
          await c.query(
            `insert into conteudo.estudo_passagem (estudo_id, ordem, versiculo_inicio, versiculo_fim, referencia_texto)
             select $1, x.ordem, x.inicio, x.fim, x.ref
             from unnest($2::int2[], $3::int4[], $4::int4[], $5::text[]) as x(ordem, inicio, fim, ref)`,
            [
              estudoId,
              e.passagens.map((p) => p.ordem),
              e.passagens.map((p) => p.inicio),
              e.passagens.map((p) => p.fim),
              e.passagens.map((p) => p.referenciaTexto),
            ],
          );
        }
      }
      if (conteudo.perguntas) perguntas = await gravarPerguntas(c, conteudo.perguntas);
      await c.query("commit");
    } catch (erro) {
      await c.query("rollback").catch(() => {});
      throw sanitizarErroDeBanco(erro);
    }
  } finally {
    if (proprio) await c.end().catch(() => {});
  }
  return { estudos, trilhas, afirmacoes, divergencias, perguntas };
}

/** Os três conjuntos de perguntas da Leitura contínua: substituídos só quando algo mudou. */
async function gravarPerguntas(c: pg.Client, conjuntos: string[][]): Promise<number> {
  const querido = conjuntos.flatMap((perguntas, conjunto) =>
    perguntas.map((texto, i) => `${conjunto}|${i + 1}|${texto}`),
  );
  const atuais = await c.query<{ conjunto: number; ordem: number; texto: string }>(
    "select conjunto, ordem, texto from conteudo.pergunta_volta order by conjunto, ordem",
  );
  const existente = atuais.rows.map((r) => `${r.conjunto}|${r.ordem}|${r.texto}`);
  if (existente.length === querido.length && existente.every((v, i) => v === querido[i])) return 0;
  await c.query("delete from conteudo.pergunta_volta");
  for (const [conjunto, perguntas] of conjuntos.entries()) {
    for (const [i, texto] of perguntas.entries()) {
      await c.query(
        "insert into conteudo.pergunta_volta (conjunto, ordem, texto) values ($1, $2, $3)",
        [conjunto, i + 1, texto],
      );
    }
  }
  return querido.length;
}

/**
 * Afirmações do Estudo (TRIL-07), na mesma transação: upsert por id autoral (texto e hash). Um id que
 * sumiu do conteúdo só é apagado se não tiver Citação; texto mudado com Citação existente também
 * falha (a revisão da Citação vem antes). Um id que já pertence a outro Estudo nunca é tomado.
 */
async function reconciliarAfirmacoes(
  c: pg.Client,
  estudoId: string,
  e: EstudoLido,
  contagem: ResultadoConteudo["afirmacoes"],
): Promise<void> {
  const atuais = await c.query<{
    id: string;
    estudo_id: string | null;
    texto_hash: string;
    ordem: number | null;
  }>("select id, estudo_id, texto_hash, ordem from acervo.afirmacao where id = any($1::text[]) or estudo_id = $2", [
    e.afirmacoes.map((a) => a.id),
    estudoId,
  ]);
  const porId = new Map(atuais.rows.map((r) => [r.id, r]));
  const temCitacao = async (id: string): Promise<boolean> =>
    ((await c.query("select 1 from acervo.citacao where afirmacao_id = $1 limit 1", [id])).rowCount ?? 0) > 0;

  for (const a of e.afirmacoes) {
    const atual = porId.get(a.id);
    const hash = textoDaAfirmacao(a.texto);
    if (!atual) {
      await c.query(
        `insert into acervo.afirmacao (id, estudo_id, texto, texto_hash, ordem) values ($1, $2, $3, $4, $5)`,
        [a.id, estudoId, a.texto, hash, a.ordem],
      );
      contagem.inseridos++;
    } else if (atual.estudo_id !== estudoId) {
      throw new ErroCarga(`Afirmação ${a.id}: o id já pertence a outro Estudo`);
    } else if (atual.texto_hash !== hash) {
      if (await temCitacao(a.id))
        throw new ErroCarga(`Afirmação ${a.id}: o texto mudou e ela já tem Citação; revise a Citação antes`);
      await c.query("update acervo.afirmacao set texto = $2, texto_hash = $3, ordem = $4 where id = $1", [
        a.id,
        a.texto,
        hash,
        a.ordem,
      ]);
      contagem.atualizados++;
    } else if (atual.ordem !== a.ordem) {
      await c.query("update acervo.afirmacao set ordem = $2 where id = $1", [a.id, a.ordem]);
      contagem.atualizados++;
    } else {
      contagem.inalterados++;
    }
  }
  const queFicam = new Set(e.afirmacoes.map((a) => a.id));
  for (const r of atuais.rows) {
    if (r.estudo_id !== estudoId || queFicam.has(r.id)) continue;
    if (await temCitacao(r.id))
      throw new ErroCarga(`Afirmação ${r.id}: o id saiu do conteúdo e ela já tem Citação`);
    await c.query("delete from acervo.afirmacao where id = $1", [r.id]);
    contagem.removidas++;
  }
}

function lerDir(argumentos: string[]): string {
  const i = argumentos.indexOf("--dir");
  if (i < 0) return PASTA_PADRAO;
  const valor = argumentos[i + 1];
  if (!valor) throw new ErroConteudo("Uso: content:load [--dir <pasta>]");
  return path.resolve(valor);
}

async function principal(): Promise<void> {
  const dir = lerDir(process.argv.slice(2));
  const conteudo = await lerPasta(dir);
  // Na pasta padrão (o conteúdo completo) as contagens são lei: 8, 30 e 89 Estudos e 3 conjuntos de
  // perguntas. Em outra pasta (fixtures de teste) só são relatadas.
  if (dir === path.resolve(PASTA_PADRAO)) conferirContagens(conteudo);
  const r = await carregarConteudo(conteudo);
  console.log(
    `inseridos=${r.estudos.inseridos} atualizados=${r.estudos.atualizados} inalterados=${r.estudos.inalterados}`,
  );
  console.log(
    `trilhas inseridas=${r.trilhas.inseridos} atualizadas=${r.trilhas.atualizados} inalteradas=${r.trilhas.inalterados}`,
  );
  console.log(
    `afirmacoes inseridas=${r.afirmacoes.inseridos} atualizadas=${r.afirmacoes.atualizados} inalteradas=${r.afirmacoes.inalterados} removidas=${r.afirmacoes.removidas} divergencias=${r.divergencias} perguntas=${r.perguntas}`,
  );
  const porTrilha = (id: string) => conteudo.estudos.filter((e) => e.frontMatter.trilha === id).length;
  console.log(
    `carregado: base-historica=${porTrilha("base-historica")} pontos-centrais=${porTrilha("pontos-centrais")} leitura-continua=${porTrilha("leitura-continua")} conjuntos-de-perguntas=${conteudo.perguntas?.length ?? 0}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => {
    // Só erro nosso mostra texto; o resto vai só com código e classe (a URL é segredo).
    if (erro instanceof ErroConteudo || erro instanceof ErroCarga) console.error(erro.message);
    else registrarErro("content-load", erro);
    process.exit(1);
  });
}
