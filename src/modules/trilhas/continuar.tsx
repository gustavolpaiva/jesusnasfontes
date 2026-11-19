import Link from "next/link";
import { Button } from "@/components/ui/button";

// Bloco "Continuar de onde parei" (TRIL-05), antes das Trilhas. A posição vem de `privado.posicao`, que
// mora no banco: por isso vale em qualquer aparelho em que a mesma conta entre. Sem posição, o bloco
// oferece o primeiro Estudo.

type Props = {
  /** O último Estudo aberto, ou `null` se esta conta nunca abriu um. */
  posicao: { slug: string; titulo: string } | null;
  /** O primeiro Estudo, para quem ainda não abriu nenhum. */
  primeiro: { slug: string } | null;
};

export function Continuar({ posicao, primeiro }: Props) {
  const destino = posicao ?? primeiro;
  if (!destino) return null;
  return (
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
  );
}
