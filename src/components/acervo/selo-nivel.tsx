import { Badge } from "@/components/ui/badge";
import { NOME_DO_NIVEL } from "@/modules/acervo/niveis";
import type { Nivel } from "@/modules/acervo/schemas";

// Selo de Nível de fonte: contorno sólido de 1 px, sem preenchimento, Rótulo em versalete, e o texto
// sempre presente (a distinção nunca depende de cor). É a variante `nivel` do chip de fonte; o Grau de
// certeza é outro selo (forma diferente: sem contorno, com preenchimento), definido numa tela própria.

export const ROTULO_DO_NIVEL: Record<Nivel, string> = NOME_DO_NIVEL;

export function SeloNivel({ nivel }: { nivel: Nivel }) {
  return (
    <Badge variant="nivel" data-slot="selo-nivel" data-nivel={nivel}>
      {ROTULO_DO_NIVEL[nivel]}
    </Badge>
  );
}
