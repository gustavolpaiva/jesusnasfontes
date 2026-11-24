import "server-only";
import { sql } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import { registrarErro } from "@/lib/registro";
import { lerPassagem } from "@/modules/texto/passagem";
import { referenciaDaPassagem } from "./citacoes";
import {
  type ContagemDosFiltros,
  contarFiltros,
  type EstadoDaProposta,
  estadoDaProposta,
  estaNoFiltro,
  type FiltroDeGraus,
  type GrauDeCerteza,
} from "./estado-da-proposta";
import type { Idioma, Nivel } from "./schemas";

// As leituras do painel de graus propostos (ACER-06, ACER-10, UI-SPEC tela 13). O Admin com segundo fator lê a proposta, as
// Citações e a aprovação pela política de linha do banco (a transação carrega o id da sessão: `comAdmin`); sem essa
// sessão as tabelas devolvem zero linhas. Tudo o que monta UMA tela sai de UM instantâneo (`{ instantaneo: true }`: REPEATABLE
// READ, só leitura): a contagem dos filtros, o "n de total" e a lista leem o mesmo estado, e o estado de cada proposta é
// derivado das mesmas linhas que a lista mostra. A Passagem bíblica é a única leitura fora dele: o texto dela é imutável
// e quem o lê (`lerPassagem`) abre a própria transação.

export type CitacaoProposta =
  | {
      tipo: "paragrafo";
      id: string;
      nivel: Nivel;
      obra: string;
      autor: string | null;
      ref: string;
      trecho: string | null;
      idioma: Idioma;
    }
  | {
      tipo: "ficha";
      id: string;
      nivel: Nivel;
      obra: string;
      pagina: { inicio: number | null; fim: number | null; texto: string | null };
      trecho: string | null;
      idioma: Idioma;
      /** Ficha verificada para o hash ATUAL dela; sem isso a Citação não vale. */
      verificada: boolean;
    }
  | {
      tipo: "passagem";
      id: string;
      nivel: "primaria";
      referencia: string;
      /** O intervalo de versículos (ids do banco), para ler o texto. */
      inicio: number;
      fim: number;
      versiculos: { numero: number; texto: string }[] | null;
    };

export type PropostaDoPainel = {
  afirmacaoId: string;
  frase: string;
  estudoSlug: string;
  estudoTitulo: string;
  grauProposto: GrauDeCerteza;
  justificativa: string;
  estado: EstadoDaProposta;
  /** O Grau da aprovação que vale hoje (só quando o estado é "aprovada"). */
  grauAprovado: GrauDeCerteza | null;
  /** Os dois hashes que o navegador devolve ao aprovar: os que ESTA leitura viu. */
  textoHash: string;
  citacoesHash: string;
  fichasFaltando: string[];
  fontesFaltando: string[];
  citacoes: CitacaoProposta[];
};

export type PainelDeGraus = {
  filtro: FiltroDeGraus;
  /** Afirmações com a aprovação valendo (o que o Estudante vê) e o total de Afirmações, ambos medidos do banco. */
  meta: { aprovadas: number; total: number };
  contagens: ContagemDosFiltros;
  propostas: PropostaDoPainel[];
  /** Quantas propostas do filtro ainda não cabem na lista (para "Mostrar mais propostas"). */
  restantes: number;
};

type LinhaDaProposta = {
  id: string;
  frase: string;
  estudo_slug: string;
  estudo_titulo: string;
  grau_proposto: string;
  justificativa: string;
  proposta_texto_hash: string;
  afirmacao_texto_hash: string;
  citacoes_hash: string;
  alvos_sustentam: boolean;
  aprovacao_grau: string | null;
  aprovacao_texto_hash: string | null;
  aprovacao_citacoes_hash: string | null;
  fichas_faltando: string[];
  fontes_faltando: string[];
};

type LinhaDaCitacao = {
  afirmacao_id: string;
  id: string;
  trecho: string | null;
  idioma: string | null;
  versiculo_inicio: number | null;
  versiculo_fim: number | null;
  paragrafo_ref: string | null;
  paragrafo_texto: string | null;
  paragrafo_idioma: string | null;
  fonte_titulo: string | null;
  fonte_autor: string | null;
  fonte_nivel: string | null;
  fonte_idioma: string | null;
  item_id: string | null;
  item_texto_pt: string | null;
  item_pagina_inicio: number | null;
  item_pagina_fim: number | null;
  item_pagina_texto: string | null;
  item_trecho_original: string | null;
  item_idioma_trecho: string | null;
  ficha_titulo: string | null;
  ficha_nivel: string | null;
  ficha_verificada: boolean | null;
};

const idiomaValido = (v: string | null | undefined): Idioma | null =>
  v === "pt" || v === "en" ? v : null;

const TETO_DO_TRECHO = 600;
function recortar(texto: string | null | undefined): string | null {
  const t = (texto ?? "").trim();
  if (t === "") return null;
  return t.length > TETO_DO_TRECHO ? `${t.slice(0, TETO_DO_TRECHO).trimEnd()}…` : t;
}

/**
 * Lê o painel inteiro num instantâneo único. `ate` é quantas propostas do filtro entram na lista (20 por vez).
 * As Afirmações sem Citação proposta não entram (não há o que aprovar): a lista é de propostas COM Citação.
 */
export async function lerPainelDeGraus(
  sessaoId: string,
  filtro: FiltroDeGraus,
  ate: number,
): Promise<PainelDeGraus> {
  const lido = await comAdmin(
    sessaoId,
    async (tx) => {
      const total = await tx.execute(
        sql`select count(*)::int as total, (count(*) filter (where acervo.aprovacao_vale(a.id)))::int as aprovadas from acervo.afirmacao a`,
      );
      const proposta = await tx.execute(sql`
        select
          p.afirmacao_id as id,
          a.texto as frase,
          e.slug as estudo_slug,
          e.titulo as estudo_titulo,
          p.grau_proposto,
          p.justificativa,
          p.texto_hash as proposta_texto_hash,
          a.texto_hash as afirmacao_texto_hash,
          acervo.hash_citacoes(a.id) as citacoes_hash,
          acervo.citacoes_sustentadas(a.id) as alvos_sustentam,
          ap.grau as aprovacao_grau,
          ap.texto_hash as aprovacao_texto_hash,
          ap.citacoes_hash as aprovacao_citacoes_hash,
          array(
            select distinct o.titulo
              from acervo.citacao c
              join acervo.ficha_item i on i.id = c.ficha_item_id
              join acervo.ficha fi on fi.fonte_id = i.ficha_id
              join acervo.fonte o on o.id = fi.fonte_id
             where c.afirmacao_id = a.id
               and not exists (
                 select 1 from acervo.verificacao_ficha v
                  where v.ficha_id = fi.fonte_id and v.ficha_hash = fi.conteudo_hash)
             order by 1) as fichas_faltando,
          array(
            select distinct o.titulo
              from acervo.citacao c
              join acervo.fonte_paragrafo pa on pa.id = c.fonte_paragrafo_id
              join acervo.fonte_secao s on s.id = pa.secao_id
              join acervo.fonte o on o.id = s.fonte_id
             where c.afirmacao_id = a.id and not (o.tipo_texto = 'integral' and o.publicada)
             order by 1) as fontes_faltando
        from acervo.proposta_grau p
        join acervo.afirmacao a on a.id = p.afirmacao_id
        join conteudo.estudo e on e.id = a.estudo_id
        join conteudo.trilha t on t.id = e.trilha_id
        left join acervo.aprovacao_afirmacao ap on ap.afirmacao_id = a.id
        where exists (select 1 from acervo.citacao c where c.afirmacao_id = a.id)
        order by t.ordem, e.ordem, a.ordem, a.id`);
      const totais = total.rows[0] as { total: number; aprovadas: number } | undefined;
      const linhas = proposta.rows as unknown as LinhaDaProposta[];

      // O estado de cada proposta, do mesmo instantâneo que a lista e a contagem.
      const estados = new Map<string, EstadoDaProposta>(
        linhas.map((l) => [
          l.id,
          estadoDaProposta({
            propostaTextoHash: l.proposta_texto_hash,
            afirmacaoTextoHash: l.afirmacao_texto_hash,
            aprovacao:
              l.aprovacao_texto_hash && l.aprovacao_citacoes_hash
                ? { textoHash: l.aprovacao_texto_hash, citacoesHash: l.aprovacao_citacoes_hash }
                : null,
            citacoesHash: l.citacoes_hash,
            fichasNaoVerificadas: l.fichas_faltando.length,
            alvosSustentam: l.alvos_sustentam,
          }),
        ]),
      );
      const doFiltro = linhas.filter((l) =>
        estaNoFiltro(estados.get(l.id) as EstadoDaProposta, filtro),
      );
      const daPagina = doFiltro.slice(0, ate);

      let citacoes: LinhaDaCitacao[] = [];
      if (daPagina.length > 0) {
        const ids = sql.join(
          daPagina.map((l) => sql`${l.id}`),
          sql`, `,
        );
        const r = await tx.execute(sql`
          select
            c.afirmacao_id, c.id::text as id, c.trecho, c.idioma, c.versiculo_inicio, c.versiculo_fim,
            pa.ref as paragrafo_ref, pa.texto as paragrafo_texto, pa.idioma as paragrafo_idioma,
            fo.titulo as fonte_titulo, fo.autor as fonte_autor, fo.nivel as fonte_nivel, fo.idioma as fonte_idioma,
            i.id as item_id, i.texto_pt as item_texto_pt, i.pagina_inicio as item_pagina_inicio,
            i.pagina_fim as item_pagina_fim, i.pagina_texto as item_pagina_texto,
            i.trecho_original as item_trecho_original, i.idioma_trecho as item_idioma_trecho,
            fio.titulo as ficha_titulo, fio.nivel as ficha_nivel,
            (v.ficha_id is not null) as ficha_verificada
          from acervo.citacao c
          left join acervo.fonte_paragrafo pa on pa.id = c.fonte_paragrafo_id
          left join acervo.fonte_secao s on s.id = pa.secao_id
          left join acervo.fonte fo on fo.id = s.fonte_id
          left join acervo.ficha_item i on i.id = c.ficha_item_id
          left join acervo.ficha fi on fi.fonte_id = i.ficha_id
          left join acervo.fonte fio on fio.id = fi.fonte_id
          left join acervo.verificacao_ficha v on v.ficha_id = fi.fonte_id and v.ficha_hash = fi.conteudo_hash
          where c.afirmacao_id in (${ids})
          order by c.afirmacao_id, c.ordem`);
        citacoes = r.rows as unknown as LinhaDaCitacao[];
      }
      return {
        totais: totais ?? { total: 0, aprovadas: 0 },
        linhas,
        estados,
        doFiltro,
        daPagina,
        citacoes,
      };
    },
    { instantaneo: true },
  );

  const porAfirmacao = new Map<string, CitacaoProposta[]>();
  for (const c of lido.citacoes) {
    const montada = montarCitacao(c);
    if (!montada) continue;
    const lista = porAfirmacao.get(c.afirmacao_id) ?? [];
    lista.push(montada);
    porAfirmacao.set(c.afirmacao_id, lista);
  }
  await resolverPassagens(porAfirmacao);

  const propostas = lido.daPagina.map((l): PropostaDoPainel => {
    const estado = lido.estados.get(l.id) as EstadoDaProposta;
    return {
      afirmacaoId: l.id,
      frase: l.frase,
      estudoSlug: l.estudo_slug,
      estudoTitulo: l.estudo_titulo,
      grauProposto: l.grau_proposto as GrauDeCerteza,
      justificativa: l.justificativa,
      estado,
      grauAprovado: estado === "aprovada" ? (l.aprovacao_grau as GrauDeCerteza) : null,
      textoHash: l.afirmacao_texto_hash,
      citacoesHash: l.citacoes_hash,
      fichasFaltando: l.fichas_faltando,
      fontesFaltando: l.fontes_faltando,
      citacoes: porAfirmacao.get(l.id) ?? [],
    };
  });

  return {
    filtro,
    meta: lido.totais,
    contagens: contarFiltros(lido.linhas.map((l) => lido.estados.get(l.id) as EstadoDaProposta)),
    propostas,
    restantes: Math.max(0, lido.doFiltro.length - lido.daPagina.length),
  };
}

function montarCitacao(c: LinhaDaCitacao): CitacaoProposta | null {
  if (c.paragrafo_ref !== null && c.fonte_titulo !== null) {
    return {
      tipo: "paragrafo",
      id: c.id,
      nivel: c.fonte_nivel as Nivel,
      obra: c.fonte_titulo,
      autor: c.fonte_autor,
      ref: c.paragrafo_ref,
      trecho: recortar(c.trecho ?? c.paragrafo_texto),
      idioma:
        idiomaValido(c.idioma) ??
        idiomaValido(c.paragrafo_idioma) ??
        idiomaValido(c.fonte_idioma) ??
        "pt",
    };
  }
  if (c.item_id !== null && c.ficha_titulo !== null) {
    const original = recortar(c.trecho ?? c.item_trecho_original);
    return {
      tipo: "ficha",
      id: c.id,
      nivel: c.ficha_nivel as Nivel,
      obra: c.ficha_titulo,
      pagina: {
        inicio: c.item_pagina_inicio,
        fim: c.item_pagina_fim,
        texto: c.item_pagina_texto,
      },
      trecho: original ?? recortar(c.item_texto_pt),
      idioma: original
        ? (idiomaValido(c.idioma) ?? idiomaValido(c.item_idioma_trecho) ?? "pt")
        : "pt",
      verificada: c.ficha_verificada === true,
    };
  }
  if (c.versiculo_inicio !== null && c.versiculo_fim !== null) {
    return {
      tipo: "passagem",
      id: c.id,
      nivel: "primaria",
      referencia: referenciaDaPassagem(c.versiculo_inicio, c.versiculo_fim),
      inicio: c.versiculo_inicio,
      fim: c.versiculo_fim,
      versiculos: null,
    };
  }
  return null;
}

/** Acrescenta o texto de cada Passagem; a falha na leitura é registrada (sem texto do banco) e a tela mostra só a referência. */
async function resolverPassagens(mapa: Map<string, CitacaoProposta[]>): Promise<void> {
  for (const lista of mapa.values()) {
    for (const item of lista) {
      if (item.tipo !== "passagem") continue;
      try {
        const lida = await lerPassagem([{ inicio: item.inicio, fim: item.fim }]);
        const versiculos = lida.trechos
          .flatMap((t) => t.capitulos.flatMap((c) => c.versiculos))
          .map((v) => ({ numero: v.numero, texto: v.conteudo }));
        item.versiculos = versiculos.length > 0 ? versiculos : null;
      } catch (erro) {
        registrarErro("graus-passagem", erro);
        item.versiculos = null;
      }
    }
  }
}

/** Quantas propostas ainda esperam o dono (tudo o que não está aprovado): o que a entrada da administração mostra. */
export async function contarPropostasPendentes(sessaoId: string): Promise<number> {
  // `ate: 0`: só as contagens (nenhuma Citação nem Passagem é lida).
  const painel = await lerPainelDeGraus(sessaoId, "pendentes", 0);
  return painel.contagens.pendentes;
}
