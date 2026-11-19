// Filete de progresso de uma Trilha (TRIL-04): 4 px com preenchimento em rubrica e, ao lado, o texto que
// leva a informação ("3 de 8 concluídos"). A barra é só reforço visual; o texto vale por si.
// Só o que esta pessoa concluiu: nada de contagem de dias nem de comparação com outros Estudantes.

type Props = {
  concluidos: number;
  total: number;
  /** Nome da Trilha, para o nome acessível da barra. */
  trilha: string;
  /** Só na Leitura contínua: "· volta 2" ao fim do texto. */
  volta?: number;
};

export function ProgressRule({ concluidos, total, trilha, volta }: Props) {
  const texto = `${concluidos} de ${total} concluídos`;
  const comVolta = volta === undefined ? texto : `${texto} · volta ${volta}`;
  const percentual = total > 0 ? Math.min(100, Math.round((concluidos / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-4 py-2" data-slot="progress-rule">
      <div
        role="progressbar"
        aria-label={`Progresso em ${trilha}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={concluidos}
        aria-valuetext={comVolta}
        className="relative h-1 min-w-16 flex-1 overflow-hidden rounded-sm bg-border"
      >
        <div className="h-full bg-primary" style={{ width: `${percentual}%` }} />
      </div>
      <p className="text-meta shrink-0 text-ink-muted">{comVolta}</p>
    </div>
  );
}
