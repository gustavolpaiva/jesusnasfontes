import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import { conferenciaItem, ficha, fichaItem, verificacaoFicha } from "@/db/schema/acervo-ficha";
import { fonte, fonteParagrafo, fonteSecao } from "@/db/schema/texto";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { type EstadoDaFicha, estadoDaFicha, posicaoNaFila } from "./estado-da-ficha";
import type { Idioma, Nivel } from "./schemas";

// Leituras do painel de Fontes (ACER-08). O Admin com segundo fator vê as Fontes não publicadas pela política de linha
// do banco (a transação carrega o id da sessão; `comAdmin`). Cada leitura confere `exigirAdmin()` primeiro: a página
// também confere, mas uma consulta nunca depende de quem a chamou.

export type OrigemDoRegistro = "arquivo" | "painel";

export type FonteNaLista = {
  slug: string;
  titulo: string;
  nivel: Nivel;
  tipoTexto: "integral" | "ficha";
  publicada: boolean;
  origem: OrigemDoRegistro;
  emConflito: boolean;
};

export type SecaoDoPainel = {
  id: string;
  slug: string;
  ordem: number;
  /** Versão da seção (uuid regerado a cada escrita): o formulário a devolve ao editar (0025). */
  versao: string;
  titulo: string | null;
  resumoPt: string | null;
  palavrasChavePt: string[];
  /** Texto com os parágrafos separados por linha em branco. Só preenchido para Fonte do painel. */
  texto: string;
  paragrafos: number;
};

export type FonteDoPainel = {
  slug: string;
  titulo: string;
  autor: string | null;
  epoca: string | null;
  nivel: Nivel;
  tradicao: string | null;
  idioma: Idioma;
  tipoTexto: "integral" | "ficha";
  obraProtegida: boolean;
  origemNome: string | null;
  origemUrl: string | null;
  licenca: string | null;
  licencaUrl: string | null;
  tradutor: string | null;
  traducaoAno: number | null;
  edicao: string | null;
  traduzidaPorNos: boolean;
  limitesPt: string | null;
  publicada: boolean;
  origem: OrigemDoRegistro;
  /** Sobe a cada escrita do painel ou da carga que muda a Fonte: o formulário a devolve e o banco recusa a velha. */
  revisao: number;
  /** Campos que a última carga recusou porque o painel os editou (vazio = sem conflito). */
  conflito: string[];
  secoes: SecaoDoPainel[];
};

const ehOrigem = (v: string): OrigemDoRegistro => (v === "painel" ? "painel" : "arquivo");

/** Todas as Fontes, publicadas ou não, por título. */
export async function listarFontesDoPainel(): Promise<FonteNaLista[]> {
  const sessao = await exigirAdmin();
  const linhas = await comAdmin(sessao.sessao.id, (tx) =>
    tx
      .select({
        slug: fonte.slug,
        titulo: fonte.titulo,
        nivel: fonte.nivel,
        tipoTexto: fonte.tipoTexto,
        publicada: fonte.publicada,
        origem: fonte.origemRegistro,
        conflito: fonte.conflitoCarga,
      })
      .from(fonte)
      .orderBy(asc(fonte.titulo)),
  );
  return linhas
    .map((l) => ({
      slug: l.slug,
      titulo: l.titulo,
      nivel: l.nivel as Nivel,
      tipoTexto: (l.tipoTexto === "integral" ? "integral" : "ficha") as "integral" | "ficha",
      publicada: l.publicada,
      origem: ehOrigem(l.origem),
      emConflito: l.conflito.length > 0,
    }))
    .sort((a, b) => a.titulo.localeCompare(b.titulo, "pt-BR"));
}

/** A Fonte e as seções dela, ou `null` se não existe. O texto vem só da Fonte do painel (a do arquivo não o edita). */
export async function lerFonteDoPainel(slug: string): Promise<FonteDoPainel | null> {
  const sessao = await exigirAdmin();
  return comAdmin(
    sessao.sessao.id,
    async (tx) => {
      const f = (await tx.select().from(fonte).where(eq(fonte.slug, slug)))[0];
      if (!f) return null;
      const secoes = await tx
        .select()
        .from(fonteSecao)
        .where(eq(fonteSecao.fonteId, f.id))
        .orderBy(asc(fonteSecao.ordem));
      const doPainel = f.origemRegistro === "painel";
      const paragrafos = doPainel
        ? await tx
            .select({ secaoId: fonteParagrafo.secaoId, texto: fonteParagrafo.texto })
            .from(fonteParagrafo)
            .innerJoin(fonteSecao, eq(fonteSecao.id, fonteParagrafo.secaoId))
            .where(eq(fonteSecao.fonteId, f.id))
            .orderBy(asc(fonteParagrafo.secaoId), asc(fonteParagrafo.ordem))
        : [];
      const porSecao = new Map<string, string[]>();
      for (const p of paragrafos)
        porSecao.set(p.secaoId, [...(porSecao.get(p.secaoId) ?? []), p.texto]);
      return {
        slug: f.slug,
        titulo: f.titulo,
        autor: f.autor,
        epoca: f.epoca,
        nivel: f.nivel as Nivel,
        tradicao: f.tradicao,
        idioma: (f.idioma === "en" ? "en" : "pt") as Idioma,
        tipoTexto: (f.tipoTexto === "integral" ? "integral" : "ficha") as "integral" | "ficha",
        obraProtegida: f.obraProtegida,
        origemNome: f.origemNome,
        origemUrl: f.origemUrl,
        licenca: f.licenca,
        licencaUrl: f.licencaUrl,
        tradutor: f.tradutor,
        traducaoAno: f.traducaoAno,
        edicao: f.edicao,
        traduzidaPorNos: f.traduzidaPorNos,
        limitesPt: f.limitesPt,
        publicada: f.publicada,
        origem: ehOrigem(f.origemRegistro),
        conflito: f.conflitoCarga,
        revisao: f.revisao,
        secoes: secoes.map((s) => ({
          id: s.id,
          slug: s.slug,
          ordem: s.ordem,
          versao: s.versao,
          titulo: s.titulo,
          resumoPt: s.resumoPt,
          palavrasChavePt: s.palavrasChavePt,
          texto: (porSecao.get(s.id) ?? []).join("\n\n"),
          paragrafos: porSecao.get(s.id)?.length ?? 0,
        })),
      } satisfies FonteDoPainel;
    },
    { instantaneo: true },
  );
}

// ───────────────────────── fichas a verificar (ACER-07, plano 02-18) ─────────────────────────
//
// Estas duas leituras recebem o id da sessão do Admin (a página o tira de `exigirAdmin()`), e cada uma lê tudo numa
// instrução SÓ: em READ COMMITTED uma instrução vê um instantâneo, então a ficha, os itens, as conferências e a
// verificação nunca vêm de momentos diferentes. Mesmo assim o que o navegador devolve ao agir (hash do item, hash da
// ficha) é conferido de novo pelas funções do banco, que travam a linha.

export type ItemParaConferir = {
  /** Identidade estável do item (`<slug>/<tipo>-<n>`): é por ela que a tela e as ações casam as linhas, nunca pela posição. */
  id: string;
  tipo: "argumento" | "trecho";
  ordem: number;
  textoPt: string;
  pagina: { inicio: number | null; fim: number | null; texto: string | null };
  trechoOriginal: string | null;
  idiomaTrecho: Idioma | null;
  /** O hash do item que o Admin está vendo: a conferência só vale para ele. */
  hash: string;
  /** Quando foi conferido, SE a conferência é do hash atual; `null` = "A conferir". */
  conferidaEm: Date | null;
};

export type FichaParaAdmin = {
  fonteId: string;
  slug: string;
  titulo: string;
  autor: string | null;
  ano: number | null;
  editora: string | null;
  edicaoConsultada: string;
  /** `false` enquanto a edição consultada ainda é "A confirmar": o banco recusa verificar. */
  edicaoConfirmada: boolean;
  tesePt: string;
  limitesPt: string | null;
  idiomaTrechos: Idioma;
  /** O hash da ficha que o Admin está vendo; a verificação só vale para ele. */
  hash: string;
  /** Quando foi verificada, SE a verificação é do hash atual. */
  verificadaEm: Date | null;
  estado: EstadoDaFicha;
  conferidos: number;
  total: number;
  argumentos: ItemParaConferir[];
  trechos: ItemParaConferir[];
};

const EDICAO_A_CONFIRMAR = /^a confirmar/i;

/** A ficha inteira com a conferência de cada item, ou `null` se não existe (404). Rascunho incluído: é para o Admin. */
export async function lerFichaParaAdmin(
  sessaoId: string,
  slug: string,
): Promise<FichaParaAdmin | null> {
  const linhas = await comAdmin(sessaoId, (tx) =>
    tx
      .select({
        fonteId: fonte.id,
        slug: fonte.slug,
        titulo: fonte.titulo,
        autor: fonte.autor,
        limitesPt: fonte.limitesPt,
        ano: ficha.ano,
        editora: ficha.editora,
        edicaoConsultada: ficha.edicaoConsultada,
        tesePt: ficha.tesePt,
        idiomaTrechos: ficha.idiomaTrechos,
        hash: ficha.conteudoHash,
        verificacaoHash: verificacaoFicha.fichaHash,
        verificadaEm: verificacaoFicha.verificadaEm,
        itemId: fichaItem.id,
        itemTipo: fichaItem.tipo,
        itemOrdem: fichaItem.ordem,
        itemTexto: fichaItem.textoPt,
        itemInicio: fichaItem.paginaInicio,
        itemFim: fichaItem.paginaFim,
        itemPaginaTexto: fichaItem.paginaTexto,
        itemTrecho: fichaItem.trechoOriginal,
        itemIdiomaTrecho: fichaItem.idiomaTrecho,
        itemHash: fichaItem.conteudoHash,
        conferenciaHash: conferenciaItem.itemHash,
        conferidaEm: conferenciaItem.conferidaEm,
      })
      .from(fonte)
      .innerJoin(ficha, eq(ficha.fonteId, fonte.id))
      .leftJoin(verificacaoFicha, eq(verificacaoFicha.fichaId, ficha.fonteId))
      .leftJoin(fichaItem, eq(fichaItem.fichaId, ficha.fonteId))
      .leftJoin(conferenciaItem, eq(conferenciaItem.itemId, fichaItem.id))
      .where(and(eq(fonte.slug, slug), eq(fonte.tipoTexto, "ficha")))
      .orderBy(asc(fichaItem.tipo), asc(fichaItem.ordem)),
  );
  const topo = linhas[0];
  if (!topo) return null;

  const itens: ItemParaConferir[] = [];
  for (const l of linhas) {
    if (l.itemId === null || l.itemHash === null) continue;
    // Toda afirmação de ficha mostra a página: o item sem página não se confere (a carga já o recusa).
    if (l.itemInicio === null && (l.itemPaginaTexto ?? "") === "") continue;
    itens.push({
      id: l.itemId,
      tipo: l.itemTipo === "trecho" ? "trecho" : "argumento",
      ordem: l.itemOrdem ?? 0,
      textoPt: l.itemTexto ?? "",
      pagina: { inicio: l.itemInicio, fim: l.itemFim, texto: l.itemPaginaTexto },
      trechoOriginal: l.itemTrecho,
      idiomaTrecho: (l.itemIdiomaTrecho ?? null) as Idioma | null,
      hash: l.itemHash,
      conferidaEm: l.conferenciaHash === l.itemHash ? l.conferidaEm : null,
    });
  }
  const conferidos = itens.filter((i) => i.conferidaEm !== null).length;
  const verificacao = topo.verificacaoHash === null ? null : { hash: topo.verificacaoHash };
  const estado = estadoDaFicha({ conferidos, total: itens.length, verificacao, hash: topo.hash });
  return {
    fonteId: topo.fonteId,
    slug: topo.slug,
    titulo: topo.titulo,
    autor: topo.autor,
    ano: topo.ano,
    editora: topo.editora,
    edicaoConsultada: topo.edicaoConsultada,
    edicaoConfirmada: !EDICAO_A_CONFIRMAR.test(topo.edicaoConsultada),
    tesePt: topo.tesePt,
    limitesPt: topo.limitesPt,
    idiomaTrechos: topo.idiomaTrechos as Idioma,
    hash: topo.hash,
    verificadaEm: estado === "verificada" ? topo.verificadaEm : null,
    estado,
    conferidos,
    total: itens.length,
    argumentos: itens.filter((i) => i.tipo === "argumento"),
    trechos: itens.filter((i) => i.tipo === "trecho"),
  };
}

export type FichaNaFila = {
  slug: string;
  titulo: string;
  autor: string | null;
  ano: number | null;
  estado: EstadoDaFicha;
  conferidos: number;
  total: number;
  verificadaEm: Date | null;
};

/** Todas as fichas (rascunho incluído) na ordem do contrato: prontas, em conferência, rascunhos, alteradas, verificadas. */
export async function filaDeFichas(sessaoId: string): Promise<FichaNaFila[]> {
  const linhas = await comAdmin(sessaoId, (tx) =>
    tx
      .select({
        slug: fonte.slug,
        titulo: fonte.titulo,
        autor: fonte.autor,
        ano: ficha.ano,
        hash: ficha.conteudoHash,
        verificacaoHash: verificacaoFicha.fichaHash,
        verificadaEm: verificacaoFicha.verificadaEm,
        total: sql<number>`count(${fichaItem.id}) filter (where ${fichaItem.paginaInicio} is not null or coalesce(${fichaItem.paginaTexto}, '') <> '')::int`,
        conferidos: sql<number>`count(${conferenciaItem.itemId}) filter (where ${conferenciaItem.itemHash} = ${fichaItem.conteudoHash} and (${fichaItem.paginaInicio} is not null or coalesce(${fichaItem.paginaTexto}, '') <> ''))::int`,
      })
      .from(fonte)
      .innerJoin(ficha, eq(ficha.fonteId, fonte.id))
      .leftJoin(verificacaoFicha, eq(verificacaoFicha.fichaId, ficha.fonteId))
      .leftJoin(fichaItem, eq(fichaItem.fichaId, ficha.fonteId))
      .leftJoin(conferenciaItem, eq(conferenciaItem.itemId, fichaItem.id))
      .where(eq(fonte.tipoTexto, "ficha"))
      .groupBy(
        fonte.slug,
        fonte.titulo,
        fonte.autor,
        ficha.ano,
        ficha.conteudoHash,
        verificacaoFicha.fichaHash,
        verificacaoFicha.verificadaEm,
      ),
  );
  return linhas
    .map((l) => {
      const estado = estadoDaFicha({
        conferidos: l.conferidos,
        total: l.total,
        verificacao: l.verificacaoHash === null ? null : { hash: l.verificacaoHash },
        hash: l.hash,
      });
      return {
        slug: l.slug,
        titulo: l.titulo,
        autor: l.autor,
        ano: l.ano,
        estado,
        conferidos: l.conferidos,
        total: l.total,
        verificadaEm: estado === "verificada" ? l.verificadaEm : null,
      } satisfies FichaNaFila;
    })
    .sort(
      (a, b) =>
        posicaoNaFila(a.estado) - posicaoNaFila(b.estado) ||
        a.titulo.localeCompare(b.titulo, "pt-BR"),
    );
}

/** Quantas fichas ainda esperam verificação (todas menos as verificadas): o que a entrada da administração mostra. */
export function pendentesDaFila(fila: readonly FichaNaFila[]): number {
  return fila.filter((f) => f.estado !== "verificada").length;
}
