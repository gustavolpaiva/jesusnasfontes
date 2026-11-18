import { exigirSessao } from "@/modules/identidade/sessao";

export default async function PaginaTrilhas() {
  await exigirSessao();
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Trilhas</h1>
      <p className="text-leitura">
        Três caminhos em sequência: a base histórica, os pontos centrais e a leitura capítulo a
        capítulo. Até 10 minutos por Estudo, sem data para acabar.
      </p>
    </div>
  );
}
