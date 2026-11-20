import { Skeleton } from "@/components/ui/skeleton";

// Carregando o Caderno: o título, a busca e três entradas. A casca vem do layout do grupo e não é trocada.
export default function Carregando() {
  return (
    <div className="coluna-leitura flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Carregando o Caderno…</span>
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-12 w-full" />
      {Array.from({ length: 3 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: barras idênticas e sem estado
        <div key={i} className="flex flex-col gap-2 py-3">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}
