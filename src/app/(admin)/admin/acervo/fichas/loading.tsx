import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Só o esqueleto: a casca vem do layout do grupo. Serve à fila e ao detalhe (a rota `[slug]` herda este carregamento).
export default function Carregando() {
  return (
    <div className="mx-auto w-full max-w-[var(--largura-ampla)]" data-slot="carregando-fichas">
      <SkeletonBlock />
    </div>
  );
}
