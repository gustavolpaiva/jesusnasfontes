import { notFound } from "next/navigation";
import { Suspense } from "react";
import { registrarErro } from "@/lib/registro";
import { CorpoEstudo } from "@/modules/conteudo/corpo-estudo";
import { type EstudoCompleto, lerEstudoPorSlug } from "@/modules/conteudo/estudo";
import { exigirSessao } from "@/modules/identidade/sessao";
import { decompor, formatarReferencia, LIVROS } from "@/modules/referencias";
import { lerPassagem } from "@/modules/texto";
import { AcoesDoEstudo } from "@/modules/trilhas/acoes-do-estudo";
import { lerEstadoDoEstudo, TRILHA_LEITURA_CONTINUA } from "@/modules/trilhas/consultas";
import { eyebrowDoEstudo, vizinhos } from "@/modules/trilhas/navegacao";
import {
  PassagemBiblica,
  PassagemCarregando,
  PassagemErro,
  type PassagemParaTela,
} from "@/modules/trilhas/passagem-biblica";
import { registrarPosicao } from "@/modules/trilhas/posicao";

// A posição muda a cada abertura e a resposta é de uma pessoa só: nunca é guardada em cache
// (também o cabeçalho `Cache-Control: no-store`, em next.config.ts).
export const dynamic = "force-dynamic";

const ID_DO_ESTUDO = "estudo";

const NOME_DA_EDICAO: Record<string, string> = {
  n4: "texto crítico, Nestle 1904",
  tr: "Textus Receptus",
};

const nomeDoLivro = (numero: number) => LIVROS.find((l) => l.numero === numero)?.nome ?? "";

// O texto bíblico chega separado do resto da página (Suspense): o Estudo aparece mesmo se a leitura
// do texto demorar ou falhar, e a falha vira o erro do próprio bloco, com "Tentar de novo".
async function PassagemDoEstudo({ estudo }: { estudo: EstudoCompleto }) {
  let passagem: PassagemParaTela;
  try {
    const lida = await lerPassagem(estudo.passagens);
    passagem = {
      edicao: NOME_DA_EDICAO[lida.edicao] ?? lida.edicao,
      trechos: lida.trechos.map((trecho, indice) => ({
        referencia: formatarReferencia(estudo.passagens[indice]?.referenciaTexto ?? ""),
        capitulos: trecho.capitulos.map((c) => ({
          subtitulo: trecho.capitulos.length > 1 ? `${nomeDoLivro(c.livro)} ${c.capitulo}` : null,
          versiculos: c.versiculos.map((v) => ({
            chave: v.chave,
            numero: v.numero,
            conteudo: v.conteudo,
          })),
        })),
        mesclados: trecho.mesclados.map((m) => decompor(m.chave).versiculo),
      })),
    };
  } catch (erro) {
    // Só o contexto, o código e a classe vão para o registro: o erro do banco não entra nele.
    registrarErro("estudo-passagem", erro);
    return <PassagemErro />;
  }
  return <PassagemBiblica passagem={passagem} idDoEstudo={ID_DO_ESTUDO} />;
}

function metaDoEstudo(estudo: EstudoCompleto): string {
  const duracao =
    estudo.trilha.id === TRILHA_LEITURA_CONTINUA
      ? "um capítulo, de 4 a 8 minutos"
      : estudo.minutos
        ? `cerca de ${estudo.minutos} minutos`
        : null;
  return [duracao, estudo.passagens.length > 0 ? null : "sem leitura bíblica neste Estudo"]
    .filter(Boolean)
    .join(" · ");
}

export default async function PaginaEstudo({ params }: { params: Promise<{ slug: string }> }) {
  const { usuario } = await exigirSessao();
  const { slug } = await params;
  // Slug inexistente é a página comum de não encontrado; falha de banco sobe para o `error.tsx`.
  const estudo = await lerEstudoPorSlug(slug);
  if (!estudo) notFound();

  await registrarPosicao(usuario.id, { trilhaId: estudo.trilha.id, estudoId: estudo.id });

  const [vizinhanca, estado] = await Promise.all([
    vizinhos(estudo),
    lerEstadoDoEstudo(usuario.id, { estudoId: estudo.id, trilhaId: estudo.trilha.id }),
  ]);
  const eyebrow = eyebrowDoEstudo({
    trilha: estudo.trilha,
    grupo: estudo.grupo,
    inicioDaPassagem: estudo.passagens[0]?.inicio ?? null,
    indice: vizinhanca?.indice ?? estudo.ordem,
    total: vizinhanca?.total ?? estudo.ordem,
    concluido: estado.concluido,
  });
  const meta = metaDoEstudo(estudo);

  return (
    <article className="coluna-leitura flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <p className="text-label text-balance text-rubric">{eyebrow}</p>
        <h1 className="text-display">{estudo.titulo}</h1>
        {meta ? <p className="text-meta text-ink-muted">{meta}</p> : null}
      </header>
      {estudo.passagens.length > 0 ? (
        <Suspense fallback={<PassagemCarregando />}>
          <PassagemDoEstudo estudo={estudo} />
        </Suspense>
      ) : null}
      {/* Destino do link "Ir para o Estudo": recebe o foco ao ser alcançado. */}
      <div id={ID_DO_ESTUDO} tabIndex={-1} className="scroll-mt-6 outline-none">
        <CorpoEstudo estudo={estudo} />
      </div>
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
