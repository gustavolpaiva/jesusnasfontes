import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Só o esqueleto: a casca vem do layout do grupo.
export default function Carregando() {
  return (
    <div className="mx-auto w-full max-w-[var(--largura-ampla)]">
      <SkeletonBlock />
    </div>
  );
}
