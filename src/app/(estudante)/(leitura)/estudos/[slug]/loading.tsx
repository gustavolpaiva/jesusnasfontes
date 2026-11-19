import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando o Estudo: a casca (cabeçalho, navegação) vem do layout do grupo e não é trocada.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock barrasDeCorpo={5} rotulo="Carregando o Estudo…" />
    </div>
  );
}
