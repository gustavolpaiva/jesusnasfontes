import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { comAcervo } from "@/db/com-acervo";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { estudo, trilha } from "@/db/schema/conteudo";
import { posicao } from "@/db/schema/posicao";
import { sessao } from "@/db/schema/sessao";
import { travarProgresso } from "@/modules/trilhas/consultas";
import { validarAnotacaoDaSessao } from "./anotacao";
import { formatarDuracao, minutosEntre } from "./formato";

// Sessão de estudo (TRIL-03): o intervalo entre um check-in e um check-out, com o Estudo em que começou,
// o Estudo em que parou e uma Anotação da Sessão opcional. Dado PRIVADO: tudo passa por `comEstudante`, e
// a RLS forçada decide de quem é a linha.
//
// FILA: abrir e encerrar uma Sessão pedem a MESMA trava por Estudante das escritas de progresso, de
// exportar e de apagar a conta (`travarProgresso`), ANTES de ler o estado. Duas abas fazendo check-out
// juntas: a segunda espera a primeira e acha a Sessão já encerrada. Check-out junto de apagar a conta ou
// de uma nova volta: um espera o outro, na mesma ordem de travas (sem impasse).

export { formatarDuracao };

// A porta é a única entrada para `privado.*`; o parâmetro existe para os testes a trocarem por uma
// montada sobre um pool de uma conexão. O código da aplicação não o passa.
type Porta = typeof comEstudante;
export type Opcoes = { porta?: Porta };

export type SessaoAberta = {
  id: string;
  checkInEm: Date;
  estudoSlug: string;
  estudoTitulo: string;
};

export type SessaoDoHistorico = {
  id: string;
  checkInEm: Date;
  checkOutEm: Date;
  minutos: number;
  de: string;
  ate: string;
  anotacao: string | null;
};

const fim = alias(estudo, "estudo_fim");

async function lerSessaoAberta(tx: Tx, estudanteId: string): Promise<SessaoAberta | null> {
  const [linha] = await tx
    .select({
      id: sessao.id,
      checkInEm: sessao.checkInEm,
      estudoSlug: estudo.slug,
      estudoTitulo: estudo.titulo,
    })
    .from(sessao)
    .innerJoin(estudo, eq(estudo.id, sessao.estudoInicioId))
    // O filtro explícito é um cinto; quem protege é a RLS.
    .where(and(eq(sessao.estudanteId, estudanteId), isNull(sessao.checkOutEm)));
  return linha ?? null;
}

async function lerHistorico(
  tx: Tx,
  estudanteId: string,
  limite: number,
): Promise<SessaoDoHistorico[]> {
  const linhas = await tx
    .select({
      id: sessao.id,
      checkInEm: sessao.checkInEm,
      checkOutEm: sessao.checkOutEm,
      anotacao: sessao.anotacao,
      de: estudo.titulo,
      ate: fim.titulo,
    })
    .from(sessao)
    .innerJoin(estudo, eq(estudo.id, sessao.estudoInicioId))
    .leftJoin(fim, eq(fim.id, sessao.estudoFimId))
    .where(and(eq(sessao.estudanteId, estudanteId), isNotNull(sessao.checkOutEm)))
    .orderBy(desc(sessao.checkInEm))
    .limit(limite);
  const historico: SessaoDoHistorico[] = [];
  for (const l of linhas) {
    if (!l.checkOutEm) continue;
    historico.push({
      id: l.id,
      checkInEm: l.checkInEm,
      checkOutEm: l.checkOutEm,
      minutos: minutosEntre(l.checkInEm, l.checkOutEm),
      de: l.de,
      ate: l.ate ?? l.de,
      anotacao: l.anotacao,
    });
  }
  return historico;
}

/** A Sessão aberta do Estudante, ou `null`. */
export async function sessaoAberta(
  estudanteId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<SessaoAberta | null> {
  return porta(estudanteId, (tx) => lerSessaoAberta(tx, estudanteId));
}

/** As últimas Sessões encerradas, a mais recente primeiro (padrão: 15). */
export async function historicoSessoes(
  estudanteId: string,
  limite = 15,
  { porta = comEstudante }: Opcoes = {},
): Promise<SessaoDoHistorico[]> {
  return porta(estudanteId, (tx) => lerHistorico(tx, estudanteId, limite));
}

/** O que a faixa mostra: a Sessão aberta, ou a última encerrada. Uma só transação. */
export async function faixaDaSessao(
  estudanteId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<{ aberta: SessaoAberta | null; ultima: SessaoDoHistorico | null }> {
  return porta(estudanteId, async (tx) => {
    const aberta = await lerSessaoAberta(tx, estudanteId);
    if (aberta) return { aberta, ultima: null };
    const [ultima] = await lerHistorico(tx, estudanteId, 1);
    return { aberta: null, ultima: ultima ?? null };
  });
}

// O Estudo em que a Sessão abre quando a pessoa a abre fora de um Estudo (nas Trilhas): a posição mais
// recente; sem posição, o primeiro Estudo (o mesmo "Começar" das Trilhas).
async function estudoPadrao(tx: Tx, estudanteId: string): Promise<string | null> {
  const [recente] = await tx
    .select({ id: posicao.estudoId })
    .from(posicao)
    .where(eq(posicao.estudanteId, estudanteId))
    .orderBy(desc(posicao.atualizadoEm), asc(posicao.trilhaId))
    .limit(1);
  if (recente) return recente.id;
  const [primeiro] = await tx
    .select({ id: estudo.id })
    .from(estudo)
    .innerJoin(trilha, eq(trilha.id, estudo.trilhaId))
    .orderBy(asc(trilha.ordem), asc(estudo.ordem))
    .limit(1);
  return primeiro?.id ?? null;
}

async function idPorSlug(tx: Tx, slug: string): Promise<string | null> {
  const [achado] = await tx.select({ id: estudo.id }).from(estudo).where(eq(estudo.slug, slug));
  return achado?.id ?? null;
}

export type ResultadoAbrir =
  | { ok: true; jaAberta: boolean; sessao: SessaoAberta }
  | { ok: false; erro: "nao-encontrado" };

/**
 * Abre a Sessão no Estudo pedido (`estudoSlug`) ou, sem ele, no Estudo padrão. Com uma Sessão já aberta
 * devolve a que existe e NÃO abre outra (`jaAberta`): duas abas de check-in juntas abrem uma só.
 */
export async function abrirSessao(
  estudanteId: string,
  { estudoSlug }: { estudoSlug?: string } = {},
  { porta = comEstudante }: Opcoes = {},
): Promise<ResultadoAbrir> {
  return porta(estudanteId, async (tx) => {
    await travarProgresso(tx, estudanteId);
    const existente = await lerSessaoAberta(tx, estudanteId);
    if (existente) return { ok: true as const, jaAberta: true, sessao: existente };

    const estudoId = estudoSlug
      ? await idPorSlug(tx, estudoSlug)
      : await estudoPadrao(tx, estudanteId);
    if (!estudoId) return { ok: false as const, erro: "nao-encontrado" as const };

    // `clock_timestamp()`: o instante real, com a trava já na mão (ver a migração 0012).
    await tx
      .insert(sessao)
      .values({ estudanteId, estudoInicioId: estudoId, checkInEm: sql`clock_timestamp()` });
    const aberta = await lerSessaoAberta(tx, estudanteId);
    if (!aberta) throw new Error("Sessão aberta não encontrada depois de gravada.");
    return { ok: true as const, jaAberta: false, sessao: aberta };
  });
}

export type ResultadoEncerrar =
  | { ok: true; minutos: number; de: string; ate: string }
  | { ok: false; erro: "sem-sessao-aberta" | "anotacao-invalida" };

/**
 * Encerra a Sessão aberta. `estudoSlugAtual` é o Estudo em que a pessoa está (quando o check-out vem de um
 * Estudo); sem ele, ou com um slug que não existe, o Estudo final é a posição mais recente e, na falta
 * dela, o Estudo em que a Sessão começou. A Anotação é validada (200 caracteres) ANTES de qualquer
 * consulta e nunca volta numa mensagem de erro.
 */
export async function encerrarSessao(
  estudanteId: string,
  { estudoSlugAtual, anotacao }: { estudoSlugAtual?: string | null; anotacao?: unknown },
  { porta = comEstudante }: Opcoes = {},
): Promise<ResultadoEncerrar> {
  const validada = validarAnotacaoDaSessao(anotacao);
  if (!validada.ok) return { ok: false, erro: "anotacao-invalida" };

  return porta(estudanteId, async (tx) => {
    await travarProgresso(tx, estudanteId);
    const [aberta] = await tx
      .select({ id: sessao.id, checkInEm: sessao.checkInEm, inicioId: sessao.estudoInicioId })
      .from(sessao)
      .where(and(eq(sessao.estudanteId, estudanteId), isNull(sessao.checkOutEm)));
    // Outra aba já encerrou (a trava fez esta esperar): nada a gravar.
    if (!aberta) return { ok: false as const, erro: "sem-sessao-aberta" as const };

    let fimId: string | null = estudoSlugAtual ? await idPorSlug(tx, estudoSlugAtual) : null;
    if (!fimId) {
      const [recente] = await tx
        .select({ id: posicao.estudoId })
        .from(posicao)
        .where(eq(posicao.estudanteId, estudanteId))
        .orderBy(desc(posicao.atualizadoEm), asc(posicao.trilhaId))
        .limit(1);
      fimId = recente?.id ?? aberta.inicioId;
    }

    // `greatest`: o fim nunca fica antes do início, nem se o relógio do servidor andar para trás.
    const [fechada] = await tx
      .update(sessao)
      .set({
        checkOutEm: sql`greatest(clock_timestamp(), ${sessao.checkInEm})`,
        estudoFimId: fimId,
        anotacao: validada.valor,
      })
      .where(and(eq(sessao.id, aberta.id), isNull(sessao.checkOutEm)))
      .returning({ checkOutEm: sessao.checkOutEm });
    if (!fechada?.checkOutEm) return { ok: false as const, erro: "sem-sessao-aberta" as const };

    const [titulos] = await tx
      .select({ de: estudo.titulo, ate: fim.titulo })
      .from(sessao)
      .innerJoin(estudo, eq(estudo.id, sessao.estudoInicioId))
      .leftJoin(fim, eq(fim.id, sessao.estudoFimId))
      .where(eq(sessao.id, aberta.id));
    const de = titulos?.de ?? "";
    return {
      ok: true as const,
      minutos: minutosEntre(aberta.checkInEm, fechada.checkOutEm),
      de,
      ate: titulos?.ate ?? de,
    };
  });
}

/** O título do Estudo pelo slug, para a faixa dizer "no Estudo: {título}". `null` se não existe. */
export async function tituloDoEstudo(estudoSlug: string): Promise<string | null> {
  return comAcervo(async (tx) => {
    const [achado] = await tx
      .select({ titulo: estudo.titulo })
      .from(estudo)
      .where(eq(estudo.slug, estudoSlug));
    return achado?.titulo ?? null;
  });
}
