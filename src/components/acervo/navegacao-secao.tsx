import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// Navegação entre as seções de uma Fonte: "Seção anterior" e "Próxima seção" lado a lado (secundários, 44 px,
// 8 px de folga) e "Voltar ao sumário" em ghost. Nos extremos o botão fica no mesmo lugar, `aria-disabled`,
// com a palavra do motivo em meta ("Primeira seção", "Última seção"): nada muda de posição e nada avança sozinho.

type Alvo = { slug: string } | null;

function Passo({
  sentido,
  alvo,
  slugDaFonte,
}: {
  sentido: "anterior" | "proxima";
  alvo: Alvo;
  slugDaFonte: string;
}) {
  const anterior = sentido === "anterior";
  const rotulo = anterior ? "Seção anterior" : "Próxima seção";
  const motivo = anterior ? "Primeira seção" : "Última seção";
  const icone = anterior ? (
    <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
  ) : (
    <ArrowRight aria-hidden="true" strokeWidth={1.5} />
  );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {alvo ? (
        <Button asChild variant="secondary" className="px-3">
          <Link href={`/acervo/${slugDaFonte}/${alvo.slug}`}>
            {anterior ? icone : null}
            {rotulo}
            {anterior ? null : icone}
          </Link>
        </Button>
      ) : (
        <>
          <Button type="button" variant="secondary" aria-disabled="true" className="px-3">
            {anterior ? icone : null}
            {rotulo}
            {anterior ? null : icone}
          </Button>
          <span className="text-meta text-ink-muted">{motivo}</span>
        </>
      )}
    </div>
  );
}

export function NavegacaoSecao({
  slugDaFonte,
  anterior,
  proxima,
}: {
  slugDaFonte: string;
  anterior: Alvo;
  proxima: Alvo;
}) {
  return (
    <nav aria-label="Seções desta Fonte" className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Passo sentido="anterior" alvo={anterior} slugDaFonte={slugDaFonte} />
        <Passo sentido="proxima" alvo={proxima} slugDaFonte={slugDaFonte} />
      </div>
      <Button asChild variant="ghost" className="-ml-4 self-start">
        <Link href={`/acervo/${slugDaFonte}`}>Voltar ao sumário</Link>
      </Button>
    </nav>
  );
}
