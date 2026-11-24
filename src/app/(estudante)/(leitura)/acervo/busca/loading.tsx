import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando a busca do Acervo: título, campo e três linhas. A casca vem do layout do grupo.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock barrasDeCorpo={3} rotulo="Carregando a busca…" />
    </div>
  );
}
