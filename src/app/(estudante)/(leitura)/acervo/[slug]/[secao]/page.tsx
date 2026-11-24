import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ParagrafoFonte } from "@/components/acervo/paragrafo-fonte";
import { ResumoAuxiliar } from "@/components/acervo/resumo-auxiliar";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { lerSecao, type SecaoLida } from "@/modules/acervo/consultas";
import { licencaCitaATraducao, textoDaLicenca } from "@/modules/acervo/licenca-exibida";
import { exigirSessao } from "@/modules/identidade/sessao";

// Leitura de uma seção de Fonte (ACER-02, ACER-04): uma página por seção, com âncora por parágrafo. O texto
// da Fonte entra como texto React (nunca marcação) e só Fonte publicada chega aqui.
export const dynamic = "force-dynamic";

function comPonto(texto: string): string {
  return texto.endsWith(".") ? texto : `${texto}.`;
}

// "Texto: {origem}. Licença: {licença}. Tradução de {tradutor}." A licença da edição digital já nomeia o
// tradutor e o ano: nesse caso a última frase não se repete.
function linhaDeCredito(f: SecaoLida["fonte"]): string {
  const partes = [
    f.origemNome ? `Texto: ${comPonto(f.origemNome)}` : null,
    f.licenca
      ? `Licença: ${comPonto(textoDaLicenca(f.licenca, { tradutor: f.tradutor, ano: f.traducaoAno }))}`
      : null,
    f.tradutor && !(f.licenca && licencaCitaATraducao(f.licenca))
      ? `Tradução de ${comPonto(f.tradutor)}`
      : null,
  ];
  return partes.filter(Boolean).join(" ");
}

function PassoDeSecao({
  sentido,
  alvo,
  slugDaFonte,
}: {
  sentido: "anterior" | "proxima";
  alvo: { slug: string } | null;
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

export default async function PaginaDeSecao({
  params,
}: {
  params: Promise<{ slug: string; secao: string }>;
}) {
  await exigirSessao();
  const { slug, secao: slugDaSecao } = await params;
  // Fonte inexistente, não publicada e seção que não existe dão a mesma página de não encontrado.
  const lida = await lerSecao(slug, slugDaSecao);
  if (!lida) notFound();
  const { fonte, secao, paragrafos } = lida;
  const credito = linhaDeCredito(fonte);

  return (
    <article className="coluna-leitura flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <Button asChild variant="ghost" className="-ml-4 max-w-full">
          <Link href={`/acervo/${fonte.slug}`}>
            <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
            <span className="[overflow-wrap:anywhere]">{fonte.titulo}</span>
          </Link>
        </Button>
        <p className="text-label text-balance text-rubric">
          Acervo · {fonte.titulo} · seção {secao.indice} de {secao.total}
        </p>
        <h1 className="text-display">{secao.titulo}</h1>
        <SeloNivel nivel={fonte.nivel} />
      </header>

      <ResumoAuxiliar resumoPt={secao.resumoPt} palavrasChavePt={secao.palavrasChavePt} />

      {fonte.traduzidaPorNos ? (
        <StatusMessage tipo="informacao">
          Esta tradução foi feita por nós e ainda não foi revisada por especialista. Confira com a
          edição de referência antes de citar.
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-4" data-slot="texto-da-fonte">
        {paragrafos.map((p) => (
          <ParagrafoFonte key={p.id} id={p.id} ref_={p.ref} texto={p.texto} idioma={p.idioma} />
        ))}
      </div>

      <footer className="flex flex-col gap-6">
        {credito ? (
          <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">
            {credito}{" "}
            <Link href={`/acervo/${fonte.slug}#origem`} className="text-rubric underline">
              Origem e licença
            </Link>
          </p>
        ) : null}
        <nav aria-label="Seções desta Fonte" className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <PassoDeSecao sentido="anterior" alvo={secao.anterior} slugDaFonte={fonte.slug} />
            <PassoDeSecao sentido="proxima" alvo={secao.proxima} slugDaFonte={fonte.slug} />
          </div>
          <Button asChild variant="ghost" className="-ml-4 self-start">
            <Link href={`/acervo/${fonte.slug}`}>Voltar ao sumário</Link>
          </Button>
        </nav>
      </footer>
    </article>
  );
}
