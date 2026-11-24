import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando a lista do Acervo: título, campo e três linhas. A casca vem do layout do grupo.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock barrasDeCorpo={4} rotulo="Carregando o Acervo…" />
    </div>
  );
}
