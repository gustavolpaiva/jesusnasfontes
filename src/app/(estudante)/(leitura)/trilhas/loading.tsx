import { Skeleton } from "@/components/ui/skeleton";

// Carregando as Trilhas: o título, o bloco de retomar e três linhas de gatilho. A casca vem do layout
// do grupo e não é trocada. Parado sob movimento reduzido (o próprio Skeleton cuida disso).
export default function Carregando() {
  return (
    <div className="coluna-leitura flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Carregando as Trilhas…</span>
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-32 w-full" />
      {Array.from({ length: 3 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: barras idênticas e sem estado
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
