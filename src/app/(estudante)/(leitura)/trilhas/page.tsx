import Link from "next/link";
import { Button } from "@/components/ui/button";
import { lerPrimeiroEstudo } from "@/modules/conteudo/estudo";
import { exigirSessao } from "@/modules/identidade/sessao";
import { lerUltimaPosicao } from "@/modules/trilhas/posicao";

// Cada pessoa vê a SUA posição: a leitura passa por `comEstudante` com o id da sessão.
export const dynamic = "force-dynamic";

export default async function PaginaTrilhas() {
  const { usuario } = await exigirSessao();
  const posicao = await lerUltimaPosicao(usuario.id);
  // Quem ainda não abriu nenhum Estudo começa pelo primeiro, na ordem das Trilhas e dos Estudos.
  const primeiro = posicao ? null : await lerPrimeiroEstudo();
  const destino = posicao ?? primeiro;

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Trilhas</h1>
      <p className="text-leitura">
        Três caminhos em sequência: a base histórica, os pontos centrais e a leitura capítulo a
        capítulo. Até 10 minutos por Estudo, sem data para acabar.
      </p>
      {destino ? (
        <section
          aria-labelledby="retomar-rotulo"
          className="flex flex-col items-start gap-3 border-y border-rule py-6"
        >
          <p id="retomar-rotulo" className="text-label text-rubric">
            {posicao ? "Continuar de onde parei" : "Começar"}
          </p>
          {posicao ? <p className="text-heading">{posicao.titulo}</p> : null}
          <Button asChild variant="primary">
            <Link href={`/estudos/${destino.slug}`}>
              {posicao ? "Continuar" : "Começar pelo primeiro Estudo"}
            </Link>
          </Button>
        </section>
      ) : null}
    </div>
  );
}
