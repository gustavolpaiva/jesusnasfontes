import { type DivergenciaDoEstudo, ORDEM_DAS_TRADICOES, type Tradicao } from "./estudo";

// Divergência entre tradições (TRIL-08): as leituras lado a lado, sem escolher uma. A ordem das
// tradições é fixa e igual em todo Estudo (católica, ortodoxa, protestante), todas com o mesmo peso:
// nenhuma leva acento de cor, ênfase ou mais espaço. Abaixo de 1024 px as leituras ficam empilhadas na
// coluna, na mesma ordem; de 1024 px em diante, em colunas iguais (o único bloco que sai da coluna de
// leitura, até 64rem).

const NOME: Record<Tradicao, string> = {
  catolica: "Tradição católica",
  ortodoxa: "Tradição ortodoxa",
  protestante: "Tradição protestante",
};

export function Divergencia({ divergencias }: { divergencias: DivergenciaDoEstudo[] }) {
  if (divergencias.length === 0) return null;
  return (
    <section aria-labelledby="divergencia-titulo" className="flex flex-col gap-4">
      <h2 id="divergencia-titulo" className="text-label mt-2 text-ink-muted">
        Divergência entre tradições
      </h2>
      <p className="text-leitura">
        Cristãos de tradições diferentes leem este ponto de formas diferentes. Mostramos cada
        leitura, sem escolher uma.
      </p>
      {divergencias.map((d) => {
        // A ordem vem da constante, nunca do arquivo: nenhuma tradição passa à frente da outra.
        const leituras = ORDEM_DAS_TRADICOES.flatMap((t) => {
          const l = d.leituras.find((x) => x.tradicao === t);
          return l ? [l] : [];
        });
        return (
          <div
            key={d.tema}
            data-divergencia
            className="flex flex-col gap-4 lg:relative lg:left-1/2 lg:w-[64rem] lg:max-w-[calc(100vw-6rem)] lg:-translate-x-1/2"
          >
            <p className="text-leitura font-semibold">{d.tema}</p>
            <div
              className="flex flex-col gap-4 lg:grid lg:gap-6 lg:[grid-template-columns:repeat(var(--colunas),minmax(0,1fr))]"
              style={{ "--colunas": leituras.length } as React.CSSProperties}
            >
              {leituras.map((l) => (
                <div
                  key={l.tradicao}
                  data-tradicao={l.tradicao}
                  className="flex flex-col gap-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-rule [&:not(:first-child)]:pt-4 lg:[&:not(:first-child)]:border-t-0 lg:[&:not(:first-child)]:border-l lg:[&:not(:first-child)]:pt-0 lg:[&:not(:first-child)]:pl-6"
                >
                  <h3 className="text-label text-ink">{NOME[l.tradicao]}</h3>
                  <p className="text-leitura">{l.resumo}</p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
