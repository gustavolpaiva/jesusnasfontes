import { notFound } from "next/navigation";
import { PassagemBiblica } from "@/components/estudo/passagem-biblica";
import { CorpoEstudo } from "@/modules/conteudo/corpo-estudo";
import { lerEstudoPorSlug } from "@/modules/conteudo/estudo";
import { exigirSessao } from "@/modules/identidade/sessao";
import { lerPassagem } from "@/modules/texto";
import { AcoesDoEstudo } from "@/modules/trilhas/acoes-do-estudo";
import { lerEstadoDoEstudo } from "@/modules/trilhas/consultas";
import { vizinhos } from "@/modules/trilhas/navegacao";
import { registrarPosicao } from "@/modules/trilhas/posicao";

// A posição muda a cada abertura e a resposta é de uma pessoa só: nunca é guardada em cache
// (também o cabeçalho `Cache-Control: no-store`, em next.config.ts).
export const dynamic = "force-dynamic";

export default async function PaginaEstudo({ params }: { params: Promise<{ slug: string }> }) {
  const { usuario } = await exigirSessao();
  const { slug } = await params;
  const estudo = await lerEstudoPorSlug(slug);
  if (!estudo) notFound();

  await registrarPosicao(usuario.id, { trilhaId: estudo.trilha.id, estudoId: estudo.id });

  const [passagem, vizinhanca, estado] = await Promise.all([
    estudo.passagens.length > 0 ? lerPassagem(estudo.passagens) : null,
    vizinhos(estudo),
    lerEstadoDoEstudo(usuario.id, { estudoId: estudo.id, trilhaId: estudo.trilha.id }),
  ]);
  const eyebrow = [`${estudo.trilha.nome} · estudo ${estudo.ordem}`, estudo.grupo]
    .filter(Boolean)
    .join(" · ");

  const meta = [
    estudo.minutos ? `cerca de ${estudo.minutos} minutos` : null,
    passagem ? null : "sem leitura bíblica neste Estudo",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="coluna-leitura flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <p className="text-label text-balance text-rubric">{eyebrow}</p>
        <h1 className="text-display">{estudo.titulo}</h1>
        {meta ? <p className="text-meta text-ink-muted">{meta}</p> : null}
      </header>
      {passagem ? (
        <PassagemBiblica
          referencias={estudo.passagens.map((p) => p.referenciaTexto)}
          passagem={passagem}
        />
      ) : null}
      <CorpoEstudo estudo={estudo} />
      <AcoesDoEstudo
        // Troca de Estudo remonta o componente: o estado local nunca vaza de um Estudo para outro.
        key={estudo.id}
        estudoId={estudo.id}
        anterior={vizinhanca?.anterior ?? null}
        proximo={vizinhanca?.proximo ?? null}
        concluidoInicial={estado.concluido}
      />
    </article>
  );
}
