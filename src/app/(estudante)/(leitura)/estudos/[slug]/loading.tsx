import { SkeletonBlock } from "@/components/estado/skeleton-block";

// Carregando o Estudo: a casca (cabeçalho, navegação) vem do layout do grupo e não é trocada.
// A altura mínima é a da janela: com o esqueleto curto, o rodapé e a navegação ficavam à vista no fim da
// janela e eram empurrados para fora dela quando o Estudo chegava (CLS 0,15 em 390 px, medido). Com o
// esqueleto do tamanho da janela eles já estão abaixo dela, antes e depois da troca.
export default function Carregando() {
  return (
    <div className="coluna-leitura min-h-svh">
      <SkeletonBlock barrasDeCorpo={5} rotulo="Carregando o Estudo…" />
    </div>
  );
}
