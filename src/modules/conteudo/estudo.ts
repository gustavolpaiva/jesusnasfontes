import { asc, eq } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { estudo, estudoPassagem, trilha } from "@/db/schema/conteudo";
import type { IntervaloDeChave } from "@/modules/texto/passagem";

export type GrauDeCerteza = {
  valor: "consenso" | "posicao-majoritaria" | "disputada" | null;
  texto: string | null;
  revisado: boolean;
};

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
};

export async function lerEstudoPorSlug(slug: string): Promise<EstudoCompleto | null> {
  return comAcervo(async (tx) => {
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
    const temGrau = e.grauCertezaValor !== null || e.grauCertezaTexto !== null;
    return {
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
    };
  });
}
