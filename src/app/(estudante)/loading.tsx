import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando uma página pública: uma barra de Título e três de Corpo. A casca (cabeçalho, link de
// salto, rodapé) vem do layout do grupo e NÃO faz parte do que é trocado: se o carregando
// trouxesse a própria casca, o primeiro Tab cairia no link de salto do carregando e o foco se
// perderia quando o conteúdo chegasse.
export default function Carregando() {
  return (
    <div className="coluna-leitura">
      <SkeletonBlock />
    </div>
  );
}
