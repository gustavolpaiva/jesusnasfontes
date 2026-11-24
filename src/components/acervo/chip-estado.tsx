import { Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

// Estado de uma coisa no painel do Admin (Publicada, Não publicada, Rascunho, A conferir, Conferida, Verificada,
// Pendente, Aprovada...), sobre o `badge`, no mesmo molde dos chips de convite da Fase 1. O estado nunca depende só de
// cor: a FORMA da borda muda (tracejada = pendente, sólida em --ink = concluído, sólida com ícone de alerta = atenção),
// e há sempre a palavra; o concluído leva o ícone `check`, o de atenção o `triangle-alert`.

export type TomDoEstado = "pendente" | "concluido" | "atencao";

type Props = { tom: TomDoEstado; children: ReactNode; className?: string };

export function ChipEstado({ tom, children, className }: Props) {
  if (tom === "pendente")
    return (
      <Badge variant="preparacao" data-slot="chip-estado" data-tom={tom} className={className}>
        {children}
      </Badge>
    );
  return (
    <Badge
      data-slot="chip-estado"
      data-tom={tom}
      // Atenção: borda de 2 px, para se distinguir do concluído também em escala de cinza.
      className={tom === "atencao" ? `border-2 ${className ?? ""}` : className}
    >
      {tom === "concluido" ? (
        <Check aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
      ) : (
        <TriangleAlert aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
      )}
      {children}
    </Badge>
  );
}
