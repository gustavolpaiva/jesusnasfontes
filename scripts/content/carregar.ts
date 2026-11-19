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
import { type ConteudoLido, ErroConteudo, lerPasta } from "./esquema";

export type Contagem = { inseridos: number; atualizados: number; inalterados: number };
export type ResultadoConteudo = { estudos: Contagem; trilhas: Contagem };

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
  try {
    await c.query("begin");
    try {
      await c.query("select pg_advisory_xact_lock(hashtext('jnf-carga-conteudo'))");
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

      for (const e of conteudo.estudos) {
        const fm = e.frontMatter;
        const existente = await c.query<{ id: string; conteudo_hash: string }>(
          "select id, conteudo_hash from conteudo.estudo where slug = $1",
          [fm.slug],
        );
        const linha = existente.rows[0];
        if (linha && linha.conteudo_hash === e.conteudoHash) {
          estudos.inalterados++;
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
        ];
        let estudoId: string;
        if (!linha) {
          const novo = await c.query<{ id: string }>(
            `insert into conteudo.estudo (slug, trilha_id, ordem, grupo, titulo, recorte, minutos, corpo_md,
               grau_certeza_valor, grau_certeza_texto, grau_certeza_revisado, conteudo_hash)
             values ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
            [...valores, fm.slug],
          );
          estudoId = (novo.rows[0] as { id: string }).id;
          estudos.inseridos++;
        } else {
          estudoId = linha.id;
          await c.query(
            `update conteudo.estudo set trilha_id = $1, ordem = $2, grupo = $3, titulo = $4, recorte = $5,
               minutos = $6, corpo_md = $7, grau_certeza_valor = $8, grau_certeza_texto = $9,
               grau_certeza_revisado = $10, conteudo_hash = $11, atualizado_em = now()
             where id = $12`,
            [...valores, estudoId],
          );
          // Troca das Passagens do Estudo que mudou, escopada ao id dele e dentro da transação.
          await c.query("delete from conteudo.estudo_passagem where estudo_id = $1", [estudoId]);
          estudos.atualizados++;
        }
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
      await c.query("commit");
    } catch (erro) {
      await c.query("rollback").catch(() => {});
      throw sanitizarErroDeBanco(erro);
    }
  } finally {
    if (proprio) await c.end().catch(() => {});
  }
  return { estudos, trilhas };
}

function lerDir(argumentos: string[]): string {
  const i = argumentos.indexOf("--dir");
  if (i < 0) return PASTA_PADRAO;
  const valor = argumentos[i + 1];
  if (!valor) throw new ErroConteudo("Uso: content:load [--dir <pasta>]");
  return path.resolve(valor);
}

async function principal(): Promise<void> {
  const conteudo = await lerPasta(lerDir(process.argv.slice(2)));
  const r = await carregarConteudo(conteudo);
  console.log(
    `inseridos=${r.estudos.inseridos} atualizados=${r.estudos.atualizados} inalterados=${r.estudos.inalterados}`,
  );
  console.log(
    `trilhas inseridas=${r.trilhas.inseridos} atualizadas=${r.trilhas.atualizados} inalteradas=${r.trilhas.inalterados}`,
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
