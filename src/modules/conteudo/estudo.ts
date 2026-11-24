import { asc, eq, inArray } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { estudo, estudoPassagem, trilha } from "@/db/schema/conteudo";
import { divergencia, divergenciaLeitura, perguntaVolta } from "@/db/schema/divergencia";
import { afirmacao } from "@/db/schema/texto";
import { registrarErro } from "@/lib/registro";
import {
  type CitacaoDaAfirmacao,
  type CitacoesPorAfirmacao,
  lerCitacoesAprovadas,
  resolverPassagens,
} from "@/modules/acervo/citacoes";
import type { IntervaloDeChave } from "@/modules/texto/passagem";

export type GrauDeCerteza = {
  valor: "consenso" | "posicao-majoritaria" | "disputada" | null;
  texto: string | null;
  revisado: boolean;
};

export type Tradicao = "catolica" | "ortodoxa" | "protestante";

/** Ordem fixa das tradições na tela, igual em todo Estudo: nunca sugere preferência. */
export const ORDEM_DAS_TRADICOES: readonly Tradicao[] = ["catolica", "ortodoxa", "protestante"];

export type DivergenciaDoEstudo = {
  tema: string;
  /** Na ordem fixa das tradições, não na ordem em que foram escritas. */
  leituras: { tradicao: Tradicao; resumo: string }[];
};

/** Trilha em que o conjunto de perguntas gira a cada volta. */
const TRILHA_DAS_PERGUNTAS = "leitura-continua";

export type EstudoCompleto = {
  id: string;
  slug: string;
  trilha: { id: string; nome: string; ordem: number };
  ordem: number;
  grupo: string | null;
  titulo: string;
  recorte: "historico" | "devocional";
  minutos: number | null;
  corpoMd: string;
  grauDeCerteza: GrauDeCerteza | null;
  /** Passagens como intervalos de chave, na ordem em que o Estudo as lista; `lerPassagem` as lê. */
  passagens: (IntervaloDeChave & { ordem: number; referenciaTexto: string })[];
  /**
   * Afirmações do Estudo (TRIL-07), na ordem do texto. `citacao` só existe com a aprovação do dono valendo (grau e
   * Citações com o hash atual, migração 0028); `null` mantém o chip "Fonte em preparação" (D-12), inclusive quando a
   * leitura das Citações falha: erro de Citação nunca derruba o Estudo.
   */
  afirmacoes: { id: string; texto: string; ordem: number; citacao: CitacaoDaAfirmacao | null }[];
  divergencias: DivergenciaDoEstudo[];
  /** Os três conjuntos de três perguntas, só na Leitura contínua (vazio nas outras Trilhas). */
  perguntas: string[][];
};

export type GanchoDeTeste = { entreLeituras?: () => Promise<void> };

export async function lerEstudoPorSlug(
  slug: string,
  teste: GanchoDeTeste = {},
): Promise<EstudoCompleto | null> {
  const lido = await lerEstudoSemPassagens(slug, teste);
  if (!lido) return null;
  // O texto das Passagens citadas vem da leitura de Passagem do produto (outra transação); falha ali não derruba o Estudo.
  await resolverPassagens(lido.citacoes);
  return lido.estudo;
}

// O Estudo, as Afirmações, as divergências e o Grau com as Citações vêm de várias consultas: TUDO no mesmo instantâneo
// (REPEATABLE READ, só leitura). Sem ele, uma aprovação confirmada entre a leitura do Grau e a das Citações juntaria o
// Grau de uma aprovação às Citações de outra (revisão cruzada do 02-19).
async function lerEstudoSemPassagens(
  slug: string,
  teste: GanchoDeTeste,
): Promise<{ estudo: EstudoCompleto; citacoes: CitacoesPorAfirmacao } | null> {
  return comAcervo(
    async (tx) => {
      const linhas = await tx
        .select({ estudo, trilha })
        .from(estudo)
        .innerJoin(trilha, eq(trilha.id, estudo.trilhaId))
        .where(eq(estudo.slug, slug));
      const achado = linhas[0];
      if (!achado) return null;
      const passagens = await tx
        .select()
        .from(estudoPassagem)
        .where(eq(estudoPassagem.estudoId, achado.estudo.id))
        .orderBy(asc(estudoPassagem.ordem));
      const e = achado.estudo;
      const afirmacoes = await tx
        .select({ id: afirmacao.id, texto: afirmacao.texto, ordem: afirmacao.ordem })
        .from(afirmacao)
        .where(eq(afirmacao.estudoId, e.id))
        .orderBy(asc(afirmacao.ordem));
      const divergenciasLinhas = await tx
        .select()
        .from(divergencia)
        .where(eq(divergencia.estudoId, e.id))
        .orderBy(asc(divergencia.ordem));
      const leituras =
        divergenciasLinhas.length === 0
          ? []
          : await tx
              .select()
              .from(divergenciaLeitura)
              .where(
                inArray(
                  divergenciaLeitura.divergenciaId,
                  divergenciasLinhas.map((d) => d.id),
                ),
              );
      let perguntas: string[][] = [];
      if (achado.trilha.id === TRILHA_DAS_PERGUNTAS) {
        const linhasDePerguntas = await tx
          .select()
          .from(perguntaVolta)
          .orderBy(asc(perguntaVolta.conjunto), asc(perguntaVolta.ordem));
        for (const p of linhasDePerguntas) {
          const conjunto = perguntas[p.conjunto] ?? [];
          conjunto.push(p.texto);
          perguntas[p.conjunto] = conjunto;
        }
        // Só vale se os três conjuntos chegaram inteiros; faltando um, a seção não é mostrada.
        if (perguntas.length !== 3 || perguntas.some((c) => c?.length !== 3)) perguntas = [];
      }
      // Por último e num ponto de salvamento: uma falha aqui não aborta a transação nem derruba o Estudo (T-02-53). O
      // registro leva só o contexto e o código, nunca o texto do banco.
      let citacoes: CitacoesPorAfirmacao = new Map();
      try {
        citacoes = await tx.transaction((ponto) =>
          lerCitacoesAprovadas(
            ponto as unknown as typeof tx,
            afirmacoes.map((a) => a.id),
            teste,
          ),
        );
      } catch (erro) {
        registrarErro("citacoes-do-estudo", erro);
      }
      const temGrau = e.grauCertezaValor !== null || e.grauCertezaTexto !== null;
      const estudoLido: EstudoCompleto = {
        id: e.id,
        slug: e.slug,
        trilha: { id: achado.trilha.id, nome: achado.trilha.nome, ordem: achado.trilha.ordem },
        ordem: e.ordem,
        grupo: e.grupo,
        titulo: e.titulo,
        recorte: e.recorte as EstudoCompleto["recorte"],
        minutos: e.minutos,
        corpoMd: e.corpoMd,
        grauDeCerteza: temGrau
          ? {
              valor: e.grauCertezaValor as GrauDeCerteza["valor"],
              texto: e.grauCertezaTexto,
              revisado: e.grauCertezaRevisado,
            }
          : null,
        passagens: passagens.map((p) => ({
          ordem: p.ordem,
          inicio: p.versiculoInicio,
          fim: p.versiculoFim,
          referenciaTexto: p.referenciaTexto,
        })),
        afirmacoes: afirmacoes.map((a) => ({
          id: a.id,
          texto: a.texto,
          ordem: a.ordem ?? 0,
          citacao: citacoes.get(a.id) ?? null,
        })),
        divergencias: divergenciasLinhas.map((d) => ({
          tema: d.tema,
          leituras: ORDEM_DAS_TRADICOES.flatMap((t) => {
            const l = leituras.find((x) => x.divergenciaId === d.id && x.tradicao === t);
            return l ? [{ tradicao: t, resumo: l.resumo }] : [];
          }),
        })),
        perguntas,
      };
      return { estudo: estudoLido, citacoes };
    },
    { instantaneo: true },
  );
}

/** O primeiro Estudo pela ordem das Trilhas e dos Estudos (o "Começar" de quem ainda não abriu nenhum). */
export async function lerPrimeiroEstudo(): Promise<{ slug: string; titulo: string } | null> {
  return comAcervo(async (tx) => {
    const linhas = await tx
      .select({ slug: estudo.slug, titulo: estudo.titulo })
      .from(estudo)
      .innerJoin(trilha, eq(trilha.id, estudo.trilhaId))
      .orderBy(asc(trilha.ordem), asc(estudo.ordem))
      .limit(1);
    return linhas[0] ?? null;
  });
}
