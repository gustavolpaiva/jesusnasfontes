// pnpm acervo:count [--tamanho]
//
// Contagem MEDIDA do Acervo (ACER-11, D-09, D-22): cada número sai de uma consulta ao banco. Nada é estimado, e o
// comando não compara com a meta nem aprova sozinho: imprime o medido e a meta como texto de referência.
//
// Duas conexões, uma por papel, lendo o MESMO instantâneo (a carga exporta; o aplicativo importa):
//   - o papel do aplicativo (jnf_app, pela URL agrupada, como o site lê) diz O QUE O ESTUDANTE VÊ. Quem decide é a
//     política de linha do banco (migrações 0017 e 0028): texto integral publicada, ficha com verificação do hash
//     atual e aprovação de Grau que vale (`acervo.aprovacao_vale`, a mesma consulta do painel de graus);
//   - o papel de carga (jnf_carga, pelo host direto) diz O QUE EXISTE: a Fonte de texto integral não publicada, as
//     fichas todas (as que o Estudante não vê são rascunho) e a proposta de Grau que ainda espera o dono.
// A Bíblia nunca entra na conta: mora em tabelas próprias (livro, versiculo, texto_versiculo), fora de
// `acervo.fonte` (D-16).
//
// O que se imprime: números, nomes de tabela e o texto fixo das linhas. Nenhum texto de Fonte, de ficha ou de
// Afirmação, e nenhuma credencial (as URLs vêm do ambiente, por nome, e nunca aparecem em mensagem).

import { pathToFileURL } from "node:url";
import pg from "pg";
import { AmbienteRecusado, decidirAmbiente } from "../../src/db/decidir-ambiente";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { urlDoPapel } from "../../src/db/url";
import { registrarErro } from "../../src/lib/registro";
import { NIVEIS, type Nivel } from "../../src/modules/acervo/schemas";
import { CAMINHO_LOCK, ErroDerivado, lerLock } from "./derivados";

/** Erro nosso, com texto fixo (nunca dado de consulta): pode ir ao terminal. */
export class ErroDeContagem extends Error {
  override name = "ErroDeContagem";
}

export type ContagemDoAcervo = {
  ambiente: "dev" | "producao";
  /** O que o Estudante vê, por Nível de fonte. Os três Níveis aparecem sempre, na ordem fechada. */
  fontesPublicadas: Record<Nivel, number>;
  /** Texto integral que existe e não está publicado. */
  fontesNaoPublicadas: number;
  fichasVerificadas: number;
  /** Ficha que existe e o Estudante ainda não vê: rascunho, em conferência, pronta ou alterada depois de verificada. */
  fichasRascunho: number;
  afirmacoesTotal: number;
  /** Afirmações com Citação aprovada que VALE hoje (texto, conjunto de Citações e alvos). */
  afirmacoesAprovadas: number;
  /** Propostas com Citação cuja Afirmação não tem aprovação valendo: ainda esperam o dono (a mesma conta do painel). */
  propostasPendentes: number;
};

export type TabelaMedida = { nome: string; bytes: number };

export type TamanhoDoAcervo = {
  /** Todas as tabelas do esquema `acervo` (as da Bíblia inclusas), pelo catálogo. */
  tabelas: TabelaMedida[];
  total: number;
  derivados: { arquivos: number; somaBytes: number; orcamentoTotalBytes: number };
};

export type Medicao = ContagemDoAcervo & { data: string; tamanho?: TamanhoDoAcervo };

// ───────────────────────── um instantâneo só, nos dois papéis ─────────────────────────

// O identificador do instantâneo exportado tem a forma "00000003-0000001B-1": duas partes em HEXADECIMAL maiúsculo
// (xmin e xip da versão do Postgres) e um contador decimal. Só entra na consulta depois desta conferência, porque
// `set transaction snapshot` não aceita parâmetro.
const IDENTIFICADOR_DE_INSTANTANEO = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/;

/** A carga abre a leitura (repetível, só leitura) e exporta o instantâneo dela. */
export async function abrirLeituraDoCarga(carga: pg.Client): Promise<string> {
  await carga.query("begin isolation level repeatable read read only");
  try {
    const r = await carga.query<{ snap: string }>("select pg_export_snapshot() as snap");
    const snap = r.rows[0]?.snap;
    if (!snap || !IDENTIFICADOR_DE_INSTANTANEO.test(snap))
      throw new ErroDeContagem("o banco não devolveu o instantâneo exportado");
    return snap;
  } catch (erro) {
    await carga.query("rollback").catch(() => {});
    throw erro;
  }
}

/** O aplicativo abre a leitura (repetível, só leitura) DENTRO do instantâneo que a carga exportou. */
export async function abrirLeituraDoApp(app: pg.Client, instantaneo: string): Promise<void> {
  if (!IDENTIFICADOR_DE_INSTANTANEO.test(instantaneo))
    throw new ErroDeContagem("instantâneo exportado fora do formato");
  await app.query("begin isolation level repeatable read read only");
  await app.query(`set transaction snapshot '${instantaneo}'`);
}

export async function abrirLeitura(carga: pg.Client, app: pg.Client): Promise<string> {
  const instantaneo = await abrirLeituraDoCarga(carga);
  try {
    await abrirLeituraDoApp(app, instantaneo);
  } catch (erro) {
    await fecharLeitura(carga, app);
    throw erro;
  }
  return instantaneo;
}

export async function fecharLeitura(carga: pg.Client, app: pg.Client): Promise<void> {
  await app.query("rollback").catch(() => {});
  await carga.query("rollback").catch(() => {});
}

// ───────────────────────── as consultas ─────────────────────────

const numero = (v: string | number | undefined): number => Number(v ?? 0);

/** Lê a contagem toda. As duas conexões precisam estar abertas no mesmo instantâneo (`abrirLeitura`). */
export async function lerContagem(app: pg.Client, carga: pg.Client): Promise<ContagemDoAcervo> {
  const marcador = await carga.query<{ nome: string }>("select nome from acervo.ambiente");
  const ambiente = marcador.rows.length === 1 ? marcador.rows[0]?.nome : undefined;
  if (ambiente !== "dev" && ambiente !== "producao")
    throw new ErroDeContagem(
      "marcador de ambiente ausente ou desconhecido no banco: rode as migrações",
    );
  decidirAmbiente(ambiente, process.env.VERCEL_ENV);

  // ───── o que o Estudante vê (papel do aplicativo; a política de linha decide)
  const porNivel = await app.query<{ nivel: string; n: number }>(
    "select nivel, count(*)::int as n from acervo.fonte group by nivel order by nivel",
  );
  const fontesPublicadas = Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>;
  for (const r of porNivel.rows) {
    if (!NIVEIS.includes(r.nivel as Nivel))
      throw new ErroDeContagem("Nível de fonte fora da lista fechada");
    fontesPublicadas[r.nivel as Nivel] = numero(r.n);
  }
  const fichasQueOEstudanteVe = await app.query<{ n: number }>(
    "select count(*)::int as n from acervo.fonte where tipo_texto = 'ficha'",
  );
  // A mesma consulta do painel de graus propostos: o total é o de Afirmações do banco, nunca um número escrito no código.
  const meta = await app.query<{ total: number; aprovadas: number }>(
    `select count(*)::int as total,
            (count(*) filter (where acervo.aprovacao_vale(a.id)))::int as aprovadas
       from acervo.afirmacao a`,
  );

  // ───── o que existe (papel de carga; vê todo o conteúdo)
  const naoPublicadas = await carga.query<{ n: number }>(
    "select count(*)::int as n from acervo.fonte where tipo_texto = 'integral' and not publicada",
  );
  // A carga não lê a evidência de verificação (a política de linha da 0017 só a dá ao aplicativo e ao Assistente), e
  // não precisa: "verificada" é o que o Estudante vê pela política; o resto do que existe é rascunho.
  const fichasQueExistem = await carga.query<{ n: number }>(
    "select count(*)::int as n from acervo.fonte where tipo_texto = 'ficha'",
  );
  // Pendente: proposta COM Citação cuja Afirmação não tem aprovação valendo (a sem Citação não tem o que aprovar).
  const pendentes = await carga.query<{ n: number }>(
    `select count(*)::int as n
       from acervo.proposta_grau p
       join acervo.afirmacao a on a.id = p.afirmacao_id
      where exists (select 1 from acervo.citacao c where c.afirmacao_id = a.id)
        and not acervo.aprovacao_vale(a.id)`,
  );

  // O Estudante não pode ver ficha que não existe: se vê mais do que a carga sabe que há, os papéis estão trocados.
  const verificadas = numero(fichasQueOEstudanteVe.rows[0]?.n);
  const totalDeFichas = numero(fichasQueExistem.rows[0]?.n);
  if (verificadas > totalDeFichas)
    throw new ErroDeContagem(
      "as duas leituras discordam: o aplicativo vê mais ficha do que a carga sabe que existe (os papéis estão trocados?)",
    );

  return {
    ambiente,
    fontesPublicadas,
    fontesNaoPublicadas: numero(naoPublicadas.rows[0]?.n),
    fichasVerificadas: verificadas,
    fichasRascunho: totalDeFichas - verificadas,
    afirmacoesTotal: numero(meta.rows[0]?.total),
    afirmacoesAprovadas: numero(meta.rows[0]?.aprovadas),
    propostasPendentes: numero(pendentes.rows[0]?.n),
  };
}

/** Tamanho das tabelas do esquema `acervo` (índices, TOAST e tabelas filhas inclusos) e dos derivados do lock. */
async function lerTamanho(carga: pg.Client, caminhoDoLock: string): Promise<TamanhoDoAcervo> {
  const r = await carga.query<{ nome: string; bytes: string }>(
    `select c.relname as nome, pg_total_relation_size(c.oid)::bigint as bytes
       from pg_class c
      where c.relnamespace = 'acervo'::regnamespace and c.relkind = 'r'
      order by c.relname`,
  );
  const tabelas = r.rows.map((l) => ({ nome: l.nome, bytes: numero(l.bytes) }));
  // Só o que o lock versionado declara: nenhum derivado é lido nem conferido aqui.
  const lock = lerLock(caminhoDoLock);
  return {
    tabelas,
    total: tabelas.reduce((soma, t) => soma + t.bytes, 0),
    derivados: {
      arquivos: Object.keys(lock.derivados).length,
      somaBytes: Object.values(lock.derivados).reduce((soma, d) => soma + d.bytes, 0),
      orcamentoTotalBytes: lock.orcamento_total_bytes,
    },
  };
}

/** Mede tudo num instantâneo só e fecha a leitura em qualquer caso. */
export async function medirAcervo(opcoes: {
  app: pg.Client;
  carga: pg.Client;
  tamanho?: boolean;
  lock?: string;
  agora?: () => Date;
}): Promise<Medicao> {
  try {
    await abrirLeitura(opcoes.carga, opcoes.app);
    const contagem = await lerContagem(opcoes.app, opcoes.carga);
    const tamanho = opcoes.tamanho
      ? await lerTamanho(opcoes.carga, opcoes.lock ?? CAMINHO_LOCK)
      : undefined;
    const data = (opcoes.agora ?? (() => new Date()))().toISOString();
    return { data, ...contagem, ...(tamanho ? { tamanho } : {}) };
  } finally {
    await fecharLeitura(opcoes.carga, opcoes.app);
  }
}

// ───────────────────────── a saída ─────────────────────────

/** As linhas do comando, na ordem. A data é UTC em ISO. */
export function renderizarContagem(m: Medicao): string[] {
  const linhas = [
    `CONTAGEM_ACERVO data=${m.data} ambiente=${m.ambiente}`,
    `FONTES_PUBLICADAS ${NIVEIS.map((n) => `${n}=${m.fontesPublicadas[n]}`).join(" ")}`,
    `FONTES_NAO_PUBLICADAS ${m.fontesNaoPublicadas}`,
    `FICHAS_VERIFICADAS ${m.fichasVerificadas}`,
    `FICHAS_RASCUNHO ${m.fichasRascunho}`,
    `AFIRMACOES_COM_CITACAO_APROVADA ${m.afirmacoesAprovadas} DE ${m.afirmacoesTotal}`,
    `PROPOSTAS_PENDENTES ${m.propostasPendentes}`,
    // A meta de ACER-11 como texto de referência, ao lado do medido: o comando não compara nem aprova.
    `DECLARADO fontes_primarias_publicadas=${m.fontesPublicadas.primaria} fichas_verificadas=${m.fichasVerificadas} — meta: cerca de 40 Fontes primárias e cerca de 25 fichas verificadas`,
  ];
  if (m.tamanho) {
    for (const t of m.tamanho.tabelas) linhas.push(`TABELA ${t.nome} bytes=${t.bytes}`);
    linhas.push(`TABELAS_TOTAL bytes=${m.tamanho.total}`);
    const d = m.tamanho.derivados;
    linhas.push(
      `DERIVADOS_VERSIONADOS arquivos=${d.arquivos} soma_bytes=${d.somaBytes} orcamento_total_bytes=${d.orcamentoTotalBytes} razao=${(d.somaBytes / d.orcamentoTotalBytes).toFixed(4)}`,
    );
  }
  return linhas;
}

// ───────────────────────── comando: pnpm acervo:count ─────────────────────────

async function principal(tamanho: boolean): Promise<void> {
  const app = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: true }) });
  const carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  try {
    await app.connect();
    await carga.connect();
  } catch (erro) {
    await app.end().catch(() => {});
    await carga.end().catch(() => {});
    throw sanitizarErroDeBanco(erro);
  }
  try {
    const medicao = await medirAcervo({ app, carga, tamanho });
    for (const linha of renderizarContagem(medicao)) console.log(linha);
  } finally {
    await app.end().catch(() => {});
    await carga.end().catch(() => {});
  }
}

function querTamanho(argumentos: string[]): boolean {
  const tamanho = argumentos.includes("--tamanho");
  const outros = argumentos.filter((a) => a !== "--tamanho");
  if (outros.length > 0) throw new ErroDeContagem("Uso: acervo:count [--tamanho]");
  return tamanho;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal(querTamanho(process.argv.slice(2))).then(
    () => process.exit(0),
    (erro: unknown) => {
      // Só erro nosso mostra texto; o resto vai só com código e classe (a URL do banco é segredo).
      if (
        erro instanceof ErroDeContagem ||
        erro instanceof ErroDerivado ||
        erro instanceof AmbienteRecusado
      )
        console.error(erro.message);
      else registrarErro("acervo-count", erro);
      process.exit(1);
    },
  );
}
