import { Algarismos } from "@/components/ui/algarismos";

// Selo de Grau de certeza (UI-SPEC "Selos", ACV-D1): SEM contorno, com preenchimento `--paper-soft`, canto de 2 px e três
// quadrados de 8 px à esquerda que contam o grau: Consenso = 3 cheios; Posição majoritária = 2 cheios e 1 vazado;
// Disputada = 1 cheio e 2 vazados. O número de pontos cheios cresce com a ACEITAÇÃO entre os pesquisadores, nunca com a
// "verdade". A palavra acompanha sempre, em versalete: os pontos são decoração (`aria-hidden`), e a distinção do Nível
// (contorno) não depende de cor. Só `span`: o selo vive dentro de um parágrafo.

export type GrauDoSelo = "consenso" | "posicao-majoritaria" | "disputada";

export const ROTULO_DO_GRAU: Record<GrauDoSelo, string> = {
  consenso: "Consenso",
  "posicao-majoritaria": "Posição majoritária",
  disputada: "Disputada",
};

const PONTOS_CHEIOS: Record<GrauDoSelo, number> = {
  consenso: 3,
  "posicao-majoritaria": 2,
  disputada: 1,
};

/** A frase que o painel da Citação diz depois do Grau: quanto o fato é aceito, nunca se é verdadeiro. */
export const FRASE_DO_GRAU: Record<GrauDoSelo, string> = {
  consenso: "Quase todos os pesquisadores aceitam, crentes ou não.",
  "posicao-majoritaria": "A maior parte dos pesquisadores aceita; uma minoria discorda.",
  disputada: "Pesquisadores sérios divergem e não há posição majoritária clara.",
};

export function SeloGrau({ grau }: { grau: GrauDoSelo }) {
  const cheios = PONTOS_CHEIOS[grau];
  return (
    // Sem `cn` nem `Badge`: o tailwind-merge toma `text-label` (tamanho) e `text-ink` (cor) por duas cores. O alto
    // contraste forçado (forced-colors) troca o preenchimento por CanvasText: cheio e vazado continuam distintos.
    <span
      data-slot="selo-grau"
      data-grau={grau}
      className="text-label inline-flex w-fit shrink-0 items-center gap-2 rounded-sm bg-paper-soft px-2 py-1 whitespace-nowrap text-ink"
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center gap-1"
        data-slot="pontos-do-grau"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            data-ponto={i < cheios ? "cheio" : "vazado"}
            className={
              i < cheios
                ? "box-border inline-block size-2 border border-ink bg-ink forced-colors:border-[CanvasText] forced-colors:bg-[CanvasText]"
                : "box-border inline-block size-2 border border-ink-muted bg-transparent forced-colors:border-[CanvasText]"
            }
          />
        ))}
      </span>
      <Algarismos>{ROTULO_DO_GRAU[grau]}</Algarismos>
    </span>
  );
}
