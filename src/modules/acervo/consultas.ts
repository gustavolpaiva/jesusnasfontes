import { and, asc, eq } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { fonte, fonteParagrafo, fonteSecao } from "@/db/schema/texto";
import type { Idioma, Nivel } from "./schemas";

// Leitura do Acervo pelo Estudante: só Fonte publicada. Rascunho, Fonte inexistente e seção que não existe
// dão o mesmo `null` (a tela mostra "Página não encontrada"), sem distinguir um do outro.

export type SecaoLida = {
  fonte: {
    slug: string;
    titulo: string;
    autor: string | null;
    nivel: Nivel;
    idioma: Idioma;
    origemNome: string | null;
    origemUrl: string | null;
    licenca: string | null;
    tradutor: string | null;
    traducaoAno: number | null;
    traduzidaPorNos: boolean;
  };
  secao: {
    slug: string;
    titulo: string;
    resumoPt: string | null;
    palavrasChavePt: string[];
    /** Posição da seção entre as da Fonte (1 a `total`), pela ordem. */
    indice: number;
    total: number;
    anterior: { slug: string; titulo: string } | null;
    proxima: { slug: string; titulo: string } | null;
  };
  paragrafos: { id: string; ref: string; texto: string; idioma: Idioma }[];
};

export async function lerSecao(slugFonte: string, slugSecao: string): Promise<SecaoLida | null> {
  return comAcervo(async (tx) => {
    const achada = (
      await tx
        .select()
        .from(fonte)
        .where(and(eq(fonte.slug, slugFonte), eq(fonte.publicada, true)))
    )[0];
    if (!achada) return null;

    const secoes = await tx
      .select({
        id: fonteSecao.id,
        slug: fonteSecao.slug,
        titulo: fonteSecao.titulo,
        resumoPt: fonteSecao.resumoPt,
        palavrasChavePt: fonteSecao.palavrasChavePt,
      })
      .from(fonteSecao)
      .where(eq(fonteSecao.fonteId, achada.id))
      .orderBy(asc(fonteSecao.ordem));
    const posicao = secoes.findIndex((s) => s.slug === slugSecao);
    const atual = secoes[posicao];
    if (!atual) return null;

    const paragrafos = await tx
      .select({
        id: fonteParagrafo.id,
        ref: fonteParagrafo.ref,
        texto: fonteParagrafo.texto,
        idioma: fonteParagrafo.idioma,
      })
      .from(fonteParagrafo)
      .where(eq(fonteParagrafo.secaoId, atual.id))
      .orderBy(asc(fonteParagrafo.ordem));

    const vizinha = (s: (typeof secoes)[number] | undefined) =>
      s ? { slug: s.slug, titulo: s.titulo ?? s.slug } : null;
    return {
      fonte: {
        slug: achada.slug,
        titulo: achada.titulo,
        autor: achada.autor,
        nivel: achada.nivel as Nivel,
        idioma: achada.idioma as Idioma,
        origemNome: achada.origemNome,
        origemUrl: achada.origemUrl,
        licenca: achada.licenca,
        tradutor: achada.tradutor,
        traducaoAno: achada.traducaoAno,
        traduzidaPorNos: achada.traduzidaPorNos,
      },
      secao: {
        slug: atual.slug,
        titulo: atual.titulo ?? atual.slug,
        resumoPt: atual.resumoPt,
        palavrasChavePt: atual.palavrasChavePt,
        indice: posicao + 1,
        total: secoes.length,
        anterior: vizinha(secoes[posicao - 1]),
        proxima: vizinha(secoes[posicao + 1]),
      },
      paragrafos: paragrafos.map((p) => ({
        id: p.id,
        ref: p.ref,
        texto: p.texto,
        idioma: (p.idioma ?? achada.idioma) as Idioma,
      })),
    };
  });
}
