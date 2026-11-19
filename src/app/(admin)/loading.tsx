import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Só o esqueleto: a casca vem do layout do grupo (a tela de carregando não traz a própria).
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock />
    </div>
  );
}
