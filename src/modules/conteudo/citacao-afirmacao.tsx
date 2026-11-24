"use client";

import { ArrowRight, ChevronDown, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { paginaVisivel } from "@/components/acervo/item-de-ficha";
import { FRASE_DO_GRAU, ROTULO_DO_GRAU, SeloGrau } from "@/components/acervo/selo-grau";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { Algarismos } from "@/components/ui/algarismos";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  type CitacaoDaAfirmacao,
  type ItemDeCitacao,
  nivelMaisDireto,
} from "@/modules/acervo/citacoes-tipos";

// A Citação no Estudo (ACER-06, ACER-10, D-10, D-11, D-12, D-16; UI-SPEC tela 8): o botão do par de selos que abre o
// trecho no próprio parágrafo. Substitui o chip "Fonte em preparação" SÓ nas Afirmações com Citação aprovada.
//
// O botão e o painel vivem DENTRO de um `<p>` (ou `<li>`) que o `remark-afirmacao` gera: por isso o `Collapsible` usa
// `asChild` num `<span>` e o painel só tem `span`, `q`, `a` e `em` (HTML inválido dentro de `<p>` vira erro de
// hidratação no React 19). A lista de várias Citações é `<span role="list">` com `<span role="listitem">`.
//
// Todo trecho de Fonte ou de ficha entra como TEXTO React em `<q>`/`<span>`, nunca como marcação (T-02-52).
// O botão e o painel marcam `data-slot="citacao"`; a leitura em voz sai do Markdown de origem e nunca os vê, e a cópia
// para a Anotação exclui o `data-slot`.

const FUSO = "America/Sao_Paulo";
const DATA_POR_EXTENSO = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: FUSO });

const FRASE_DO_AVISO = "Não foi possível mostrar o trecho agora.";

/** Aviso de trecho indisponível, em `span` (o `StatusMessage` é `div`/`p` e não cabe dentro de um parágrafo). */
function AvisoDoTrecho() {
  return (
    <span
      role="status"
      data-slot="aviso-do-trecho"
      data-tipo="aviso"
      className="text-ui flex w-full gap-3 rounded-sm border border-l-4 border-input border-l-signal-warning bg-transparent p-3"
    >
      <TriangleAlert
        aria-hidden="true"
        strokeWidth={1.5}
        className="mt-1 size-5 shrink-0 text-signal-warning"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="text-label mr-2 text-signal-warning">Atenção.</span>
        {FRASE_DO_AVISO}
      </span>
    </span>
  );
}

const CLASSE_DO_LINK =
  "text-ui inline-flex min-h-11 items-center gap-2 underline underline-offset-[3px] [overflow-wrap:anywhere]";

function LinhaDoGrau({ grau }: { grau: CitacaoDaAfirmacao["grau"] }) {
  return (
    <span data-slot="linha-do-grau" className="text-ui block">
      Grau de certeza: {ROTULO_DO_GRAU[grau]}. {FRASE_DO_GRAU[grau]}
    </span>
  );
}

function Trecho({ texto, idioma }: { texto: string; idioma: "pt" | "en" }) {
  return (
    <q
      lang={idioma === "en" ? "en" : "pt-BR"}
      data-slot="trecho-citado"
      className="text-leitura mt-2 block border-l-2 border-ink pl-4 [overflow-wrap:anywhere]"
    >
      {texto}
    </q>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="text-meta block text-ink-muted [overflow-wrap:anywhere]">
      <Algarismos>{children}</Algarismos>
    </span>
  );
}

function ItemDaCitacao({
  item,
  grau,
  rotulo,
  mostrarNivel,
}: {
  item: ItemDeCitacao;
  grau: CitacaoDaAfirmacao["grau"];
  rotulo: string;
  mostrarNivel: boolean;
}) {
  return (
    <span data-slot="citacao-item" data-alvo={item.tipo} className="flex flex-col gap-2">
      <span className="text-label block text-ink-muted">
        <Algarismos>{rotulo}</Algarismos>
      </span>
      {mostrarNivel ? (
        <span className="block">
          <SeloNivel nivel={item.nivel} />
        </span>
      ) : null}

      {item.tipo === "paragrafo" ? (
        <>
          <span
            data-slot="citacao-fonte"
            className="text-ui block font-semibold [overflow-wrap:anywhere]"
          >
            {item.autor ? `${item.autor}, ` : ""}
            <em>{item.obra}</em>, {item.ref}
          </span>
          {item.trecho ? (
            <>
              <Trecho texto={item.trecho} idioma={item.idioma} />
              {item.idioma === "en" ? <Meta>Trecho em inglês, como está no Acervo.</Meta> : null}
            </>
          ) : (
            <AvisoDoTrecho />
          )}
        </>
      ) : null}

      {item.tipo === "ficha" ? (
        <>
          <span
            data-slot="citacao-fonte"
            className="text-ui block font-semibold [overflow-wrap:anywhere]"
          >
            Trecho da ficha, {paginaVisivel(item.pagina) ?? "p. ?"} de <em>{item.obra}</em>
          </span>
          {item.trecho ? <Trecho texto={item.trecho} idioma={item.idioma} /> : <AvisoDoTrecho />}
          <Meta>
            Verificada em{" "}
            <time dateTime={item.verificadaEm}>
              {DATA_POR_EXTENSO.format(new Date(item.verificadaEm))}
            </time>
            .
          </Meta>
        </>
      ) : null}

      {item.tipo === "passagem" ? (
        <>
          <span
            data-slot="citacao-fonte"
            className="text-ui block font-semibold [overflow-wrap:anywhere]"
          >
            Bíblia Livre, {item.referencia}
          </span>
          {item.versiculos ? (
            <>
              <span
                lang="pt-BR"
                data-slot="trecho-citado"
                className="text-leitura mt-2 block border-l-2 border-ink pl-4 [overflow-wrap:anywhere]"
              >
                {item.versiculos.map((v) => (
                  <span key={v.numero} data-versiculo={v.numero}>
                    <sup className="mr-1 text-[0.7em] text-ink-muted select-none">{v.numero}</sup>
                    {v.texto}{" "}
                  </span>
                ))}
              </span>
              {item.edicao ? (
                <Meta>{`Texto em português, Bíblia Livre (${item.edicao}).`}</Meta>
              ) : null}
            </>
          ) : (
            <AvisoDoTrecho />
          )}
        </>
      ) : null}

      <LinhaDoGrau grau={grau} />

      {item.tipo === "paragrafo" ? (
        <Link href={item.href} className={CLASSE_DO_LINK} data-slot="citacao-link">
          <span>
            Ler na Fonte: {item.obra} {item.ref}
          </span>
          <ArrowRight aria-hidden="true" strokeWidth={1.5} className="size-5 shrink-0" />
        </Link>
      ) : null}
      {item.tipo === "ficha" ? (
        <Link href={item.href} className={CLASSE_DO_LINK} data-slot="citacao-link">
          <span>Ver a ficha de {item.obra}</span>
          <ArrowRight aria-hidden="true" strokeWidth={1.5} className="size-5 shrink-0" />
        </Link>
      ) : null}
    </span>
  );
}

/**
 * O botão do par de selos e o painel da Citação de UMA Afirmação. `ordinal` só existe quando o bloco tem mais de uma
 * Afirmação: o botão traz " · {n}" e o nome acessível ganha "Afirmação {n}".
 */
export function CitacaoAfirmacao({
  afirmacaoId,
  citacao,
  ordinal,
}: {
  afirmacaoId: string;
  citacao: CitacaoDaAfirmacao;
  ordinal: number | null;
}) {
  const [aberto, setAberto] = useState(false);
  const painelId = useId();
  const itens = citacao.itens;
  const nivel = nivelMaisDireto(itens);
  const varias = itens.length > 1;

  return (
    <Collapsible open={aberto} onOpenChange={setAberto} asChild>
      <span
        data-slot="citacao"
        data-citacao-de={afirmacaoId}
        data-aberto={aberto ? "sim" : "nao"}
        className="clear-both mt-2 block"
      >
        <CollapsibleTrigger asChild>
          {/* Nome acessível pelo CONTEÚDO (WCAG 2.5.3): Nível visível, ", Grau de certeza: ", Grau visível e a ação. */}
          <button
            type="button"
            data-slot="citacao-botao"
            // O Radix só liga `aria-controls` ao painel aberto; o contrato pede o vínculo sempre (o painel é nosso).
            aria-controls={painelId}
            className="inline-flex min-h-11 w-fit flex-wrap items-center gap-2 rounded-sm text-ink hover:bg-paper-soft [&_[data-slot=selo-grau]]:hover:bg-paper"
          >
            <SeloNivel nivel={nivel} />
            <span className="sr-only">, Grau de certeza: </span>
            <SeloGrau grau={citacao.grau} />
            <ChevronDown
              aria-hidden="true"
              strokeWidth={1.5}
              className={`size-4 shrink-0 transition-transform ${aberto ? "rotate-180" : ""}`}
            />
            {ordinal !== null ? (
              <span className="text-meta text-ink-muted">
                <span aria-hidden="true">· </span>
                <span className="sr-only">, Afirmação </span>
                {ordinal}
              </span>
            ) : null}
            <span className="sr-only">
              {aberto ? ". Esconder a Citação." : ". Mostrar a Citação."}
            </span>
          </button>
        </CollapsibleTrigger>
        {aberto ? (
          <span
            id={painelId}
            data-slot="citacao-painel"
            data-state="open"
            className="mt-2 block bg-paper-soft p-4"
          >
            {varias ? (
              <>
                <span className="text-label mb-3 block text-ink-muted">
                  <Algarismos>{`Citações (${itens.length})`}</Algarismos>
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: `ul` e `li` não cabem dentro de um `<p>` (hidratação, UI-SPEC tela 8) */}
                <span role="list" className="flex flex-col gap-4">
                  {itens.map((item, i) => (
                    // biome-ignore lint/a11y/useSemanticElements: idem, `li` não cabe dentro de um `<p>`
                    <span
                      key={item.id}
                      role="listitem"
                      className={`block ${i > 0 ? "border-t border-rule pt-4" : ""}`}
                    >
                      <ItemDaCitacao
                        item={item}
                        grau={citacao.grau}
                        rotulo={`Citação ${i + 1} de ${itens.length}`}
                        mostrarNivel
                      />
                    </span>
                  ))}
                </span>
              </>
            ) : itens[0] ? (
              <ItemDaCitacao
                item={itens[0]}
                grau={citacao.grau}
                rotulo="Citação"
                mostrarNivel={false}
              />
            ) : null}
          </span>
        ) : null}
      </span>
    </Collapsible>
  );
}
