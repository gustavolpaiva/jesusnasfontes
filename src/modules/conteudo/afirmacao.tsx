import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

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
      className={cn(
        // Logo abaixo do bloco, à esquerda, 8 px de folga; Rótulo, canto 2 px, 1 px de borda.
        "text-label mt-2 block w-fit rounded-sm border px-2 py-1 text-ink-muted",
        props.variante === "preparacao"
          ? "border-dashed border-ink-muted"
          : "border-solid border-ink",
      )}
    >
      {rotulo}
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
