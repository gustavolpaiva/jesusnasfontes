import { TriangleAlert } from "lucide-react";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { Badge } from "@/components/ui/badge";
import type { EstadoDaFicha } from "@/modules/acervo/estado-da-ficha";
import { dataCurta } from "@/modules/acervo/painel-fichas";

// O estado de uma ficha na fila e no detalhe (UI-SPEC tela 12): SEMPRE texto mais forma, nunca só cor.
//   Rascunho, Em conferência          contorno tracejado, só a palavra
//   Pronta para verificar             contorno sólido em --ink
//   Verificada em {data}              contorno sólido com `check`
//   Alterada, volta a conferir        contorno tracejado com `triangle-alert`
export function ChipDaFicha({
  estado,
  verificadaEm,
}: {
  estado: EstadoDaFicha;
  verificadaEm?: Date | string | null;
}) {
  switch (estado) {
    case "rascunho":
      return <ChipEstado tom="pendente">Rascunho</ChipEstado>;
    case "em-conferencia":
      return <ChipEstado tom="pendente">Em conferência</ChipEstado>;
    case "pronta":
      return (
        <Badge data-slot="chip-estado" data-tom="pronta">
          Pronta para verificar
        </Badge>
      );
    case "verificada":
      return (
        <ChipEstado tom="concluido">
          {verificadaEm ? `Verificada em ${dataCurta(verificadaEm)}` : "Verificada"}
        </ChipEstado>
      );
    case "alterada":
      return (
        <Badge variant="preparacao" data-slot="chip-estado" data-tom="alterada">
          <TriangleAlert aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
          Alterada, volta a conferir
        </Badge>
      );
  }
}
