import { TriangleAlert } from "lucide-react";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { ROTULO_DO_GRAU } from "@/components/acervo/selo-grau";
import { Badge } from "@/components/ui/badge";
import type { EstadoDaProposta, GrauDeCerteza } from "@/modules/acervo/estado-da-proposta";

// O estado de uma proposta de Grau na lista do Admin (UI-SPEC tela 13): SEMPRE texto mais forma, nunca só cor.
//   Pendente                 contorno tracejado, só a palavra
//   Aprovada: {Grau}         contorno sólido com `check`
//   Aguardando ficha         contorno tracejado com `triangle-alert`
//   Texto mudou              contorno tracejado com `triangle-alert`
export function ChipDaProposta({
  estado,
  grauAprovado,
}: {
  estado: EstadoDaProposta;
  grauAprovado: GrauDeCerteza | null;
}) {
  switch (estado) {
    case "pendente":
      return <ChipEstado tom="pendente">Pendente</ChipEstado>;
    case "aprovada":
      return (
        <ChipEstado tom="concluido">
          {grauAprovado ? `Aprovada: ${ROTULO_DO_GRAU[grauAprovado]}` : "Aprovada"}
        </ChipEstado>
      );
    case "aguardando-ficha":
    case "texto-mudou":
      return (
        <Badge variant="preparacao" data-slot="chip-estado" data-tom="atencao-tracejada">
          <TriangleAlert aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
          {estado === "texto-mudou" ? "Texto mudou" : "Aguardando ficha"}
        </Badge>
      );
  }
}
