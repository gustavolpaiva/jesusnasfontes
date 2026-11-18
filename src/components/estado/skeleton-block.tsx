import { Skeleton } from "@/components/ui/skeleton";

type Props = { barrasDeCorpo?: number; rotulo?: string };

// Carregamento: uma barra de Título e barras de Corpo. Parado sob movimento reduzido.
export function SkeletonBlock({ barrasDeCorpo = 3, rotulo = "Carregando…" }: Props) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4" data-slot="skeleton-block">
      <span className="sr-only">{rotulo}</span>
      <Skeleton className="h-7 w-2/3" />
      {Array.from({ length: barrasDeCorpo }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: barras idênticas e sem estado
        <Skeleton key={i} className={i === barrasDeCorpo - 1 ? "h-5 w-1/2" : "h-5 w-full"} />
      ))}
    </div>
  );
}
