import { Algarismos } from "@/components/ui/algarismos";
import { NOME_DO_NIVEL } from "@/modules/acervo/niveis";
import type { Nivel } from "@/modules/acervo/schemas";

// Selo de Nível de fonte: contorno sólido de 1 px, sem preenchimento, Rótulo em versalete, e o texto
// sempre presente (a distinção nunca depende de cor). É a variante `nivel` do chip de fonte; o Grau de
// certeza é outro selo (forma diferente: sem contorno, com preenchimento), definido em `selo-grau.tsx`.
//
// Escrito por inteiro, sem `Badge` nem `cn`: o tailwind-merge toma `text-label` (tamanho do Rótulo) e `text-ink` (cor)
// por duas cores e descarta a primeira, e o selo perdia o versalete (achado na conferência renderizada do plano
// 02-19: ao lado do Grau, o Nível aparecia em caixa baixa e o Grau em versalete). Só `span`: vive dentro de parágrafo.
//
// `className` é para o selo que mora numa coluna estreita (o painel da Citação): lá ele pode quebrar a linha em vez de
// passar da borda do painel em 320 px no passo 5 do texto.

export const ROTULO_DO_NIVEL: Record<Nivel, string> = NOME_DO_NIVEL;

export function SeloNivel({ nivel, className }: { nivel: Nivel; className?: string }) {
  return (
    <span
      data-slot="selo-nivel"
      data-nivel={nivel}
      className={`text-label inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border border-solid border-ink bg-transparent px-2 py-1 text-ink ${
        className ?? "whitespace-nowrap"
      }`}
    >
      <Algarismos>{ROTULO_DO_NIVEL[nivel]}</Algarismos>
    </span>
  );
}
