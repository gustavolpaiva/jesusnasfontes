import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AvisoDeTraducao } from "@/components/acervo/aviso-de-traducao";
import { NavegacaoSecao } from "@/components/acervo/navegacao-secao";
import { ParagrafoFonte } from "@/components/acervo/paragrafo-fonte";
import { ResumoAuxiliar } from "@/components/acervo/resumo-auxiliar";
import { RolarAteAncora } from "@/components/acervo/rolar-ate-ancora";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { Algarismos } from "@/components/ui/algarismos";
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
          <Algarismos>{`Acervo · ${fonte.titulo} · seção ${secao.indice} de ${secao.total}`}</Algarismos>
        </p>
        <h1 className="text-display text-balance [overflow-wrap:anywhere]">{secao.titulo}</h1>
        <SeloNivel nivel={fonte.nivel} />
      </header>

      {fonte.traduzidaPorNos ? <AvisoDeTraducao /> : null}

      <ResumoAuxiliar resumoPt={secao.resumoPt} palavrasChavePt={secao.palavrasChavePt} />

      <RolarAteAncora />
      <div className="flex flex-col gap-4" data-slot="texto-da-fonte">
        {paragrafos.map((p) => (
          <ParagrafoFonte key={p.id} id={p.id} ref_={p.ref} texto={p.texto} idioma={p.idioma} />
        ))}
      </div>

      <footer className="flex flex-col gap-6">
        {credito ? (
          <div className="flex flex-col items-start">
            <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">{credito}</p>
            <Link
              href={`/acervo/${fonte.slug}#origem`}
              className="text-meta inline-flex min-h-11 items-center text-rubric underline"
            >
              Origem e licença
            </Link>
          </div>
        ) : null}
        <NavegacaoSecao
          slugDaFonte={fonte.slug}
          anterior={secao.anterior}
          proxima={secao.proxima}
        />
      </footer>
    </article>
  );
}
