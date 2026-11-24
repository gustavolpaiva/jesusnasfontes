import { and, asc, eq } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { ficha, fichaItem, verificacaoFicha } from "@/db/schema/acervo-ficha";
import { fonte } from "@/db/schema/texto";
import type { Idioma } from "./schemas";

// Leitura da ficha de uma obra da Pesquisa acadêmica pelo Estudante (ACER-03, ACER-07, D-02, D-05). Quem decide a
// visibilidade é a POLÍTICA DE LINHA do banco: o papel do aplicativo só vê a ficha cuja verificação tem o hash do
// conteúdo atual. Rascunho, ficha inexistente e ficha alterada depois de verificada dão o mesmo `null` (a tela
// mostra "Página não encontrada", sem revelar que um rascunho existe). A consulta não tem coluna de pessoa: o nome
// de quem verificou mora só em `admin.registro_verificacao`, que o Estudante nunca lê (D-05).

export type PaginaDoItem = { inicio: number | null; fim: number | null; texto: string | null };

export type ItemLido = {
  id: string;
  textoPt: string;
  pagina: PaginaDoItem;
  trechoOriginal: string | null;
  idiomaTrecho: Idioma | null;
};

export type FichaLida = {
  slug: string;
  titulo: string;
  autor: string | null;
  ano: number | null;
  editora: string | null;
  edicaoConsultada: string;
  tesePt: string;
  limitesPt: string | null;
  idiomaTrechos: Idioma;
  /** Quando a ficha foi verificada. Nunca por quem (D-05). */
  verificadaEm: Date;
  argumentos: ItemLido[];
  trechos: ItemLido[];
};

/**
 * Ficha, verificação e itens são lidos no MESMO instantâneo (REPEATABLE READ, só leitura). Em READ COMMITTED, uma
 * alteração de item confirmada entre a leitura da verificação e a dos itens faria a política de linha esconder os
 * itens e a função devolver a ficha anterior como verificada, com seções sumidas: no instantâneo só existem a versão
 * verificada inteira ou nenhuma.
 *
 * `entreLeituras` é só para o teste de corrida: roda depois da leitura da verificação e antes da dos itens.
 */
export async function lerFicha(
  slug: string,
  teste: { entreLeituras?: () => Promise<void> } = {},
): Promise<FichaLida | null> {
  return comAcervo(
    async (tx) => {
      const achada = (
        await tx
          .select({
            slug: fonte.slug,
            titulo: fonte.titulo,
            autor: fonte.autor,
            limitesPt: fonte.limitesPt,
            fonteId: fonte.id,
            ano: ficha.ano,
            editora: ficha.editora,
            edicaoConsultada: ficha.edicaoConsultada,
            tesePt: ficha.tesePt,
            idiomaTrechos: ficha.idiomaTrechos,
            conteudoHash: ficha.conteudoHash,
          })
          .from(fonte)
          .innerJoin(ficha, eq(ficha.fonteId, fonte.id))
          .where(and(eq(fonte.slug, slug), eq(fonte.tipoTexto, "ficha")))
      )[0];
      if (!achada) return null;

      // A política já exigiu a verificação do hash atual; conferir de novo aqui é a segunda trava, e dá a data.
      const verificacao = (
        await tx
          .select({
            verificadaEm: verificacaoFicha.verificadaEm,
            fichaHash: verificacaoFicha.fichaHash,
          })
          .from(verificacaoFicha)
          .where(eq(verificacaoFicha.fichaId, achada.fonteId))
      )[0];
      if (!verificacao || verificacao.fichaHash !== achada.conteudoHash) return null;
      await teste.entreLeituras?.();

      const itens = await tx
        .select({
          id: fichaItem.id,
          tipo: fichaItem.tipo,
          textoPt: fichaItem.textoPt,
          paginaInicio: fichaItem.paginaInicio,
          paginaFim: fichaItem.paginaFim,
          paginaTexto: fichaItem.paginaTexto,
          trechoOriginal: fichaItem.trechoOriginal,
          idiomaTrecho: fichaItem.idiomaTrecho,
        })
        .from(fichaItem)
        .where(eq(fichaItem.fichaId, achada.fonteId))
        .orderBy(asc(fichaItem.tipo), asc(fichaItem.ordem));

      const lidos = itens
        // Toda afirmação de ficha mostra a página: item sem página não é renderizado (a carga já o recusa).
        .filter((i) => i.paginaInicio !== null || (i.paginaTexto ?? "") !== "")
        .map((i) => ({
          tipo: i.tipo,
          item: {
            id: i.id,
            textoPt: i.textoPt,
            pagina: { inicio: i.paginaInicio, fim: i.paginaFim, texto: i.paginaTexto },
            trechoOriginal: i.trechoOriginal,
            idiomaTrecho: (i.idiomaTrecho ?? null) as Idioma | null,
          } satisfies ItemLido,
        }));

      return {
        slug: achada.slug,
        titulo: achada.titulo,
        autor: achada.autor,
        ano: achada.ano,
        editora: achada.editora,
        edicaoConsultada: achada.edicaoConsultada,
        tesePt: achada.tesePt,
        limitesPt: achada.limitesPt,
        idiomaTrechos: achada.idiomaTrechos as Idioma,
        verificadaEm: verificacao.verificadaEm,
        argumentos: lidos.filter((l) => l.tipo === "argumento").map((l) => l.item),
        trechos: lidos.filter((l) => l.tipo === "trecho").map((l) => l.item),
      };
    },
    { instantaneo: true },
  );
}
