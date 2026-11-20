import type { GrauDeCerteza as Grau } from "./estudo";

// Grau de certeza do Estudo (TRIL-07): um bloco em `--paper-soft`, sem borda, com o rótulo à esquerda,
// o valor em Título (rubrica) à direita e a explicação embaixo. A cor do valor é a mesma nos três: a
// distinção está na palavra. Só se mostra quando o dono classificou e revisou (ver `CorpoEstudo`);
// por Afirmação ele não aparece na Fase 1.

const NOMES = {
  consenso: "Consenso",
  "posicao-majoritaria": "Posição majoritária",
  disputada: "Disputada",
} as const;

export function GrauDeCerteza({
  valor,
  texto,
}: {
  valor: NonNullable<Grau["valor"]>;
  texto: string | null;
}) {
  return (
    <section
      aria-labelledby="grau-de-certeza-titulo"
      className="flex flex-col gap-2 bg-paper-soft p-4"
      data-grau-de-certeza={valor}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="grau-de-certeza-titulo" className="text-label text-ink-muted">
          Grau de certeza
        </h2>
        <p className="text-heading text-rubric">{NOMES[valor]}</p>
      </div>
      {texto ? <p className="text-leitura">{texto}</p> : null}
    </section>
  );
}
