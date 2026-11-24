import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/com-estudante";
import { fichaItem, verificacaoFicha } from "@/db/schema/acervo-ficha";
import { aprovacaoAfirmacao, citacao, fonte, fonteParagrafo, fonteSecao } from "@/db/schema/texto";
import { registrarErro } from "@/lib/registro";
import { decompor, formatarReferencia, LIVROS } from "@/modules/referencias";
import { lerPassagem } from "@/modules/texto/passagem";
import type {
  CitacaoDaAfirmacao,
  CitacoesPorAfirmacao,
  Grau,
  ItemDeCitacao,
} from "./citacoes-tipos";
import type { Idioma, Nivel } from "./schemas";

// As Citações aprovadas de um Estudo (ACER-06, ACER-10, D-10, D-11, D-12, D-16). Quem decide o que o Estudante vê é a
// POLÍTICA DE LINHA do banco (migração 0028): o papel do aplicativo só lê a aprovação e as Citações de uma Afirmação
// quando o hash do texto e o do conjunto de Citações são os da aprovação e os alvos ainda sustentam a Citação. Aqui não
// há decisão de visibilidade, só leitura e montagem para a tela: uma consulta por tabela para o Estudo inteiro, nunca
// uma por Afirmação (sem N+1).
//
// Tudo o que sai daqui é DADO para a tela (texto React, nunca marcação): trecho de terceiros entra como texto.

export type {
  CitacaoDaAfirmacao,
  CitacoesPorAfirmacao,
  Grau,
  ItemDeCitacao,
  PaginaDeCitacao,
} from "./citacoes-tipos";
export { nivelMaisDireto } from "./citacoes-tipos";

type ItemBruto = ItemDeCitacao;

function idiomaValido(valor: string | null | undefined): Idioma | null {
  return valor === "pt" || valor === "en" ? valor : null;
}

/** "Lucas 2:7", "Lucas 2:7-9", "Lucas 2:7 a 3:2": por extenso, pelo mesmo interpretador do resto do produto. */
export function referenciaDaPassagem(inicio: number, fim: number): string {
  const a = decompor(inicio);
  const b = decompor(fim);
  const livro = LIVROS.find((l) => l.numero === a.livro);
  if (!livro) return `${inicio}-${fim}`;
  const ponto = (c: number, v: number) => `${c}:${v}`;
  let texto = `${livro.nome} ${ponto(a.capitulo, a.versiculo)}`;
  if (fim !== inicio) {
    if (b.livro !== a.livro)
      texto += ` a ${LIVROS.find((l) => l.numero === b.livro)?.nome ?? ""} ${ponto(b.capitulo, b.versiculo)}`;
    else if (b.capitulo === a.capitulo) texto += `-${b.versiculo}`;
    else texto += `-${ponto(b.capitulo, b.versiculo)}`;
  }
  try {
    return formatarReferencia(texto);
  } catch {
    return texto;
  }
}

/**
 * Lê, numa transação já aberta, a aprovação e as Citações das Afirmações pedidas. Devolve só as que têm Citação lida:
 * Afirmação sem aprovação válida (ou cujas Citações a política escondeu) fica de fora e segue com "Fonte em preparação".
 * A Passagem vem sem o texto (precisa de outra leitura): `resolverPassagens` o acrescenta.
 */
export async function lerCitacoesAprovadas(
  tx: Tx,
  ids: readonly string[],
): Promise<CitacoesPorAfirmacao> {
  const resultado: CitacoesPorAfirmacao = new Map();
  if (ids.length === 0) return resultado;
  const lista = [...ids];

  const graus = await tx
    .select({ id: aprovacaoAfirmacao.afirmacaoId, grau: aprovacaoAfirmacao.grau })
    .from(aprovacaoAfirmacao)
    .where(inArray(aprovacaoAfirmacao.afirmacaoId, lista));
  if (graus.length === 0) return resultado;
  const grauDe = new Map(graus.map((g) => [g.id, g.grau as Grau]));

  const citacoes = await tx
    .select({
      id: citacao.id,
      afirmacaoId: citacao.afirmacaoId,
      ordem: citacao.ordem,
      trecho: citacao.trecho,
      idioma: citacao.idioma,
      paragrafoId: citacao.fonteParagrafoId,
      fichaItemId: citacao.fichaItemId,
      inicio: citacao.versiculoInicio,
      fim: citacao.versiculoFim,
    })
    .from(citacao)
    .where(inArray(citacao.afirmacaoId, [...grauDe.keys()]))
    .orderBy(asc(citacao.afirmacaoId), asc(citacao.ordem));
  if (citacoes.length === 0) return resultado;

  const idsDeParagrafo = citacoes.flatMap((c) => (c.paragrafoId ? [c.paragrafoId] : []));
  const idsDeItem = citacoes.flatMap((c) => (c.fichaItemId ? [c.fichaItemId] : []));

  const paragrafos =
    idsDeParagrafo.length === 0
      ? []
      : await tx
          .select({
            id: fonteParagrafo.id,
            ref: fonteParagrafo.ref,
            texto: fonteParagrafo.texto,
            idiomaDoParagrafo: fonteParagrafo.idioma,
            secaoSlug: fonteSecao.slug,
            obraSlug: fonte.slug,
            obra: fonte.titulo,
            autor: fonte.autor,
            nivel: fonte.nivel,
            idiomaDaFonte: fonte.idioma,
          })
          .from(fonteParagrafo)
          .innerJoin(fonteSecao, eq(fonteSecao.id, fonteParagrafo.secaoId))
          .innerJoin(fonte, eq(fonte.id, fonteSecao.fonteId))
          .where(inArray(fonteParagrafo.id, idsDeParagrafo));
  const paragrafoPorId = new Map(paragrafos.map((p) => [p.id, p]));

  const itens =
    idsDeItem.length === 0
      ? []
      : await tx
          .select({
            id: fichaItem.id,
            textoPt: fichaItem.textoPt,
            paginaInicio: fichaItem.paginaInicio,
            paginaFim: fichaItem.paginaFim,
            paginaTexto: fichaItem.paginaTexto,
            trechoOriginal: fichaItem.trechoOriginal,
            idiomaTrecho: fichaItem.idiomaTrecho,
            obraSlug: fonte.slug,
            obra: fonte.titulo,
            nivel: fonte.nivel,
            verificadaEm: verificacaoFicha.verificadaEm,
          })
          .from(fichaItem)
          .innerJoin(fonte, eq(fonte.id, fichaItem.fichaId))
          .innerJoin(verificacaoFicha, eq(verificacaoFicha.fichaId, fichaItem.fichaId))
          .where(and(inArray(fichaItem.id, idsDeItem)));
  const itemPorId = new Map(itens.map((i) => [i.id, i]));

  const porAfirmacao = new Map<string, ItemBruto[]>();
  for (const c of citacoes) {
    let montado: ItemBruto | null = null;
    if (c.paragrafoId) {
      const p = paragrafoPorId.get(c.paragrafoId);
      // Parágrafo que a política não devolve: a Citação inteira some (nunca um item sem o alvo).
      if (p) {
        const trecho = (c.trecho ?? p.texto).trim();
        montado = {
          tipo: "paragrafo",
          id: c.id,
          nivel: p.nivel as Nivel,
          autor: p.autor,
          obra: p.obra,
          ref: p.ref,
          trecho: trecho === "" ? null : trecho,
          idioma:
            idiomaValido(c.idioma) ??
            idiomaValido(p.idiomaDoParagrafo) ??
            idiomaValido(p.idiomaDaFonte) ??
            "pt",
          href: `/acervo/${p.obraSlug}/${p.secaoSlug}#p-${p.ref}`,
        };
      }
    } else if (c.fichaItemId) {
      const i = itemPorId.get(c.fichaItemId);
      if (i) {
        const original = (c.trecho ?? i.trechoOriginal)?.trim() || null;
        montado = {
          tipo: "ficha",
          id: c.id,
          nivel: i.nivel as Nivel,
          obra: i.obra,
          pagina: { inicio: i.paginaInicio, fim: i.paginaFim, texto: i.paginaTexto },
          // O original quando há; senão o texto em português da ficha (D-11).
          trecho: original ?? (i.textoPt.trim() || null),
          idioma: original
            ? (idiomaValido(c.idioma) ?? idiomaValido(i.idiomaTrecho) ?? "pt")
            : "pt",
          verificadaEm: i.verificadaEm.toISOString(),
          href: `/acervo/${i.obraSlug}`,
        };
      }
    } else if (c.inicio !== null && c.fim !== null) {
      montado = {
        tipo: "passagem",
        id: c.id,
        nivel: "primaria",
        referencia: referenciaDaPassagem(c.inicio, c.fim),
        edicao: null,
        versiculos: null,
        inicio: c.inicio,
        fim: c.fim,
      };
    }
    if (!montado) continue;
    const lista = porAfirmacao.get(c.afirmacaoId) ?? [];
    lista.push(montado);
    porAfirmacao.set(c.afirmacaoId, lista);
  }

  for (const [id, grau] of grauDe) {
    const feitos = porAfirmacao.get(id);
    if (feitos && feitos.length > 0) resultado.set(id, { grau, itens: feitos });
  }
  return resultado;
}

/**
 * Acrescenta o texto de cada Passagem citada, pela leitura de Passagem do produto (uma por Citação). Falha na leitura
 * é registrada (sem texto do banco) e a Passagem fica com `versiculos: null`: a tela avisa, o Estudo não cai.
 */
export async function resolverPassagens(mapa: CitacoesPorAfirmacao): Promise<void> {
  for (const citacaoDaAfirmacao of mapa.values()) {
    for (const item of citacaoDaAfirmacao.itens) {
      if (item.tipo !== "passagem") continue;
      try {
        const lida = await lerPassagem([{ inicio: item.inicio, fim: item.fim }]);
        const versiculos = lida.trechos
          .flatMap((t) => t.capitulos.flatMap((c) => c.versiculos))
          .map((v) => ({ numero: v.numero, texto: v.conteudo }));
        item.edicao = lida.edicao;
        item.versiculos = versiculos.length > 0 ? versiculos : null;
      } catch (erro) {
        registrarErro("citacao-passagem", erro);
        item.versiculos = null;
      }
    }
  }
}
