import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AvisoDeTraducao } from "@/components/acervo/aviso-de-traducao";
import { BlocoProveniencia } from "@/components/acervo/bloco-proveniencia";
import { ErroDoAcervo } from "@/components/acervo/erro-do-acervo";
import { LinhaSecao } from "@/components/acervo/linha-fonte";
import { PaginaDaFicha } from "@/components/acervo/pagina-da-ficha";
import { ParagrafoFonte } from "@/components/acervo/paragrafo-fonte";
import { ResumoAuxiliar } from "@/components/acervo/resumo-auxiliar";
import { RolarAteAncora } from "@/components/acervo/rolar-ate-ancora";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { lerCarta } from "@/modules/acervo/carta";
import { type FonteLida, lerFonte } from "@/modules/acervo/consultas";
import { type FichaLida, lerFicha } from "@/modules/acervo/consultas-ficha";
import { exigirSessao } from "@/modules/identidade/sessao";

// Página da Fonte de texto integral (ACER-02, ACER-04): proveniência sempre visível, aviso de tradução,
// limites e sumário de seções. Obra de uma só seção mostra o texto aqui mesmo. Só Fonte publicada chega
// aqui. A mesma rota serve a ficha de uma obra da Pesquisa acadêmica (ACER-03, ACER-07): só a ficha
// verificada, com o hash do conteúdo atual, tem página. Fonte inexistente, não publicada, ficha em rascunho
// ou ficha alterada depois de verificada dão o mesmo "Página não encontrada" (D-02).
export const dynamic = "force-dynamic";

function notaDoIdioma(f: FonteLida["fonte"]): string {
  const traducao = f.tradutor ? `, na tradução de ${f.tradutor}` : "";
  return `Este texto está em inglês${traducao}. Cada seção traz um resumo em português para ajudar a achar e a entender o que ela trata.`;
}

export default async function PaginaDaFonte({ params }: { params: Promise<{ slug: string }> }) {
  await exigirSessao();
  const { slug } = await params;
  let lida: FonteLida | null;
  let ficha: FichaLida | null = null;
  try {
    lida = await lerFonte(slug);
    if (!lida) ficha = await lerFicha(slug);
  } catch (erro) {
    registrarErro("acervo-fonte", erro);
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <ErroDoAcervo />
      </div>
    );
  }
  if (ficha) return <PaginaDaFicha ficha={ficha} linkDaCarta={lerCarta() !== null} />;
  if (!lida) notFound();
  const { fonte, secoes, unica } = lida;
  const meta = [fonte.autor, fonte.epoca].filter(Boolean).join(" · ");

  return (
    <article className="coluna-leitura flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <Button asChild variant="ghost" className="-ml-4">
          <Link href="/acervo">
            <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
            Voltar ao Acervo
          </Link>
        </Button>
        <p className="text-label text-rubric">Acervo</p>
        <h1 className="text-display text-balance [overflow-wrap:anywhere]">{fonte.titulo}</h1>
        {meta ? <p className="text-meta text-ink-muted">{meta}</p> : null}
        <SeloNivel nivel={fonte.nivel} />
      </header>

      {fonte.traduzidaPorNos ? <AvisoDeTraducao /> : null}

      <BlocoProveniencia fonte={fonte} />

      {fonte.idioma === "en" ? (
        <p className="text-meta text-ink-muted">{notaDoIdioma(fonte)}</p>
      ) : null}

      {fonte.limitesPt ? (
        <section aria-labelledby="limites" lang="pt-BR" className="flex flex-col gap-2">
          <h2 id="limites" className="text-label">
            O que esta Fonte não pode dizer
          </h2>
          <p className="text-leitura">{fonte.limitesPt}</p>
        </section>
      ) : null}

      {unica ? (
        <section aria-labelledby="texto" className="flex flex-col gap-4">
          <h2 id="texto" className="text-label">
            Texto
          </h2>
          <ResumoAuxiliar resumoPt={unica.resumoPt} palavrasChavePt={unica.palavrasChavePt} />
          <RolarAteAncora />
          <div className="flex flex-col gap-4" data-slot="texto-da-fonte">
            {unica.paragrafos.map((p) => (
              <ParagrafoFonte key={p.id} id={p.id} ref_={p.ref} texto={p.texto} idioma={p.idioma} />
            ))}
          </div>
        </section>
      ) : secoes.length > 0 ? (
        <section aria-labelledby="sumario" data-slot="sumario">
          <h2 id="sumario" className="text-label">
            Seções ({secoes.length})
          </h2>
          <ul className="mt-2">
            {secoes.map((s) => (
              <LinhaSecao key={s.slug} slugDaFonte={fonte.slug} secao={s} />
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
