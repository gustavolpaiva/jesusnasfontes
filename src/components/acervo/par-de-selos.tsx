import { SeloGrau } from "@/components/acervo/selo-grau";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import type { Nivel } from "@/modules/acervo/schemas";

// O par Nível de fonte + Grau de certeza (ACV-D1): lido junto, sempre nesta ordem, 8 px de folga, quebra de linha permitida.
// Para os usos FORA do botão da Citação (o botão compõe os dois selos por conta própria, com o texto só para leitor de
// tela entre eles). Só `span`.

export function ParDeSelos({
  nivel,
  grau,
}: {
  nivel: Nivel;
  grau: "consenso" | "posicao-majoritaria" | "disputada";
}) {
  return (
    <span data-slot="par-de-selos" className="inline-flex flex-wrap items-center gap-2">
      <SeloNivel nivel={nivel} />
      <SeloGrau grau={grau} />
    </span>
  );
}
