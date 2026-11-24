import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { lerCarta } from "@/modules/acervo/carta";
import { exigirSessao } from "@/modules/identidade/sessao";
import { dataPorExtenso } from "@/modules/privacidade/aviso";

// Carta de neutralidade do Acervo (D-08, UI-SPEC tela 7): página de texto, na estrutura do aviso de privacidade (h1,
// lede, seções curtas com título em Rótulo, versão e data no rodapé). O texto é do dono, lido de
// `content/acervo/carta-de-neutralidade.md`; sem o arquivo a rota dá "Página não encontrada". Nada do conteúdo é
// escrito pelo agente no produto, e tudo entra como texto (Markdown só de título de seção e parágrafo).
export const dynamic = "force-dynamic";

export const metadata = { title: "Carta de neutralidade" };

export default async function PaginaDaCarta() {
  await exigirSessao();
  const carta = lerCarta();
  if (!carta) notFound();

  return (
    <article data-slot="carta" className="coluna-leitura flex flex-col gap-6">
      <header className="flex flex-col items-start gap-3">
        <Button asChild variant="ghost" className="-ml-4">
          <Link href="/acervo">
            <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
            Voltar ao Acervo
          </Link>
        </Button>
        <h1 className="text-display text-balance [overflow-wrap:anywhere]">{carta.titulo}</h1>
      </header>
      {carta.lede.map((p) => (
        <p key={p} className="text-leitura [overflow-wrap:anywhere]">
          {p}
        </p>
      ))}
      <div className="flex flex-col">
        {carta.secoes.map((secao, i) => (
          <section
            key={secao.titulo}
            aria-labelledby={`carta-${i}`}
            className="flex flex-col gap-2 border-t border-rule py-4 first:border-t-0 first:pt-0"
          >
            <h2 id={`carta-${i}`} className="text-label text-ink-muted">
              {secao.titulo}
            </h2>
            {secao.paragrafos.map((p) => (
              <p key={p} className="text-leitura [overflow-wrap:anywhere]">
                {p}
              </p>
            ))}
          </section>
        ))}
        <p
          data-slot="versao-da-carta"
          className="text-meta border-t border-rule pt-4 text-ink-muted"
        >
          Carta versão {carta.versao}, de {dataPorExtenso(carta.data)}.
        </p>
      </div>
    </article>
  );
}
