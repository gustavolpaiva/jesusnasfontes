import "server-only";
import { asc, eq } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import { fonte, fonteParagrafo, fonteSecao } from "@/db/schema/texto";
import { exigirAdmin } from "@/modules/identidade/sessao";
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
  return comAdmin(sessao.sessao.id, async (tx) => {
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
      secoes: secoes.map((s) => ({
        id: s.id,
        slug: s.slug,
        ordem: s.ordem,
        titulo: s.titulo,
        resumoPt: s.resumoPt,
        palavrasChavePt: s.palavrasChavePt,
        texto: (porSecao.get(s.id) ?? []).join("\n\n"),
        paragrafos: porSecao.get(s.id)?.length ?? 0,
      })),
    } satisfies FonteDoPainel;
  });
}
