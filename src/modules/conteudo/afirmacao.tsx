import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Algarismos } from "@/components/ui/algarismos";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// Afirmação (TRIL-07, D-07): a frase que declara um fato histórico, marcada no conteúdo com um id
// estável, e o aviso que ela leva até receber a Citação (Fase 2).
//
// A frase NÃO ganha sublinhado nem cor, para não ser confundida com link; o chip é o único sinal e é
// informação, não botão: não tem papel, não recebe foco e não responde a clique. A distinção também
// não depende de cor: é uma borda tracejada com texto.

export function Afirmacao({ id, children }: { id: string; children: ReactNode }) {
  return <span data-afirmacao-id={id}>{children}</span>;
}

type ChipProps =
  | { variante: "preparacao"; ordinal?: number | null }
  // `nivel` (borda sólida) é do Nível de fonte da Fase 2: existe como variante, não é usada agora.
  | { variante: "nivel"; ordinal?: number | null; children: ReactNode };

export function ChipFonte(props: ChipProps) {
  const rotulo =
    props.variante === "preparacao"
      ? `Fonte em preparação${props.ordinal ? ` · ${props.ordinal}` : ""}`
      : props.children;
  return (
    <span
      data-slot="chip-fonte"
      data-variante={props.variante}
      // `clear-both`: o chip fica abaixo da capitular (a letra de três linhas desce até a terceira linha
      // do texto e, sem isto, o chip seguia ao lado dela, recuado e quebrado em duas linhas).
      // Sem `cn`: o tailwind-merge toma `text-label` (tamanho do Rótulo) e `text-ink-muted` (cor) por
      // duas cores e descarta a primeira, e o chip perdia o versalete e o tamanho.
      className={`text-label clear-both mt-2 block w-fit rounded-sm border px-2 py-1 text-ink-muted ${
        props.variante === "preparacao"
          ? "border-dashed border-ink-muted"
          : "border-solid border-ink"
      }`}
    >
      <Algarismos>{rotulo}</Algarismos>
    </span>
  );
}

/** O resumo recolhido que vem antes da primeira seção com Afirmação em cada Estudo. */
export function ResumoFonteEmPreparacao() {
  return (
    <Collapsible className="flex flex-col gap-1" data-slot="resumo-fonte">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group -ml-4 self-start">
          O que é “Fonte em preparação”?
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.5}
            className="transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-leitura">
          Esta frase afirma um fato histórico. Ainda não ligamos a frase ao trecho da Fonte que a
          sustenta. Isso chega numa próxima etapa do site; até lá, leia com cautela.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** O resumo recolhido que vem antes da primeira seção com Citação aprovada, uma vez por Estudo (UI-SPEC tela 8). */
export function ResumoCitacao() {
  return (
    <Collapsible className="flex flex-col gap-1" data-slot="resumo-citacao">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group -ml-4 self-start">
          O que são os dois selos?
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.5}
            className="transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-leitura">
          Cada frase que afirma um fato histórico traz dois selos. O primeiro diz de que tipo é a
          Fonte: Fonte primária (texto antigo), Pesquisa acadêmica (obra de estudioso) ou Leitura
          confessional (uma tradição cristã, sempre nomeada). O segundo diz o Grau de certeza:
          quanto os pesquisadores aceitam o fato. Toque nos selos para ler o trecho.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
