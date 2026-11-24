import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando a Fonte: esqueleto de título e quatro linhas. A casca vem do layout do grupo.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock barrasDeCorpo={4} rotulo="Carregando a Fonte…" />
    </div>
  );
}
