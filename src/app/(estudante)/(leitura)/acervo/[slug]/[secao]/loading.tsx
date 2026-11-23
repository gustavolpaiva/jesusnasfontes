import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando a seção: título, bloco de resumo e cinco parágrafos. A casca vem do layout do grupo.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock barrasDeCorpo={5} rotulo="Carregando a seção…" />
    </div>
  );
}
