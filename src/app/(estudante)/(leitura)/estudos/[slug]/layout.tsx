import { type ReactNode, Suspense } from "react";
import { exigirSessao } from "@/modules/identidade/sessao";
import { SessaoBar } from "@/modules/sessao/sessao-bar";

// A faixa da Sessão fica acima da página do Estudo (tela 6). O layout do segmento recebe o slug pelos
// parâmetros e a faixa abre a Sessão no Estudo da tela. A leitura da Sessão vem de uma pessoa só: nunca é
// guardada em cache. A página do Estudo não é tocada.
export const dynamic = "force-dynamic";

export default async function LayoutDoEstudo({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { usuario } = await exigirSessao();
  const { slug } = await params;
  return (
    // Coluna em bloco, não em flex: a página do Estudo também é `coluna-leitura` (margem automática), e
    // dentro de um flex em coluna ela deixaria de esticar e passaria da borda com uma palavra longa.
    <div className="coluna-leitura">
      {/* A faixa não segura o texto do Estudo: o espaço de 48 px fica reservado enquanto ela carrega. */}
      <div className="mb-8">
        <Suspense fallback={<div aria-hidden="true" className="min-h-12" />}>
          <SessaoBar estudanteId={usuario.id} estudoSlug={slug} />
        </Suspense>
      </div>
      {children}
    </div>
  );
}
