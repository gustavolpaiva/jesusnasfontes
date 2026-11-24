import Link from "next/link";
import { CampoBuscaAcervo } from "@/components/acervo/campo-busca-acervo";
import { ErroDoAcervo } from "@/components/acervo/erro-do-acervo";
import { FiltroNivel } from "@/components/acervo/filtro-nivel";
import { LinhaFonte } from "@/components/acervo/linha-fonte";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type ListaDoAcervo, listarFontesPorNivel } from "@/modules/acervo/consultas-lista";
import {
  contagemEmTexto,
  FRASE_DO_NIVEL,
  lerNivelDoParametro,
  NOME_DO_NIVEL,
} from "@/modules/acervo/niveis";
import { exigirSessao } from "@/modules/identidade/sessao";

// Lista do Acervo (ACER-01, D-13): as Fontes publicadas, agrupadas por Nível na ordem fixa, com filtro por
// Nível na URL. O parâmetro passa pela lista fechada de Níveis; valor desconhecido ou Nível sem Fonte mostra
// a lista completa e um aviso. Só Fonte publicada e ficha verificada chegam aqui (política de linha).
export const dynamic = "force-dynamic";

const LEDE =
  "As Fontes em que este site se apoia: textos antigos em texto integral e fichas de obras de pesquisa. Cada uma mostra de onde veio e sob qual licença.";

export default async function PaginaDoAcervo({
  searchParams,
}: {
  searchParams: Promise<{ nivel?: string | string[] }>;
}) {
  await exigirSessao();
  const { nivel: bruto } = await searchParams;
  const nivelPedido = lerNivelDoParametro(bruto);
  // Parâmetro presente mas fora da lista fechada: sem filtro, com aviso.
  const parametroInvalido = bruto !== undefined && nivelPedido === null;

  let lista: ListaDoAcervo;
  try {
    lista = await listarFontesPorNivel(nivelPedido);
  } catch (erro) {
    // Só o contexto, o código e a classe vão para o registro: o erro do banco não entra nele.
    registrarErro("acervo-lista", erro);
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Acervo</h1>
        <ErroDoAcervo />
      </div>
    );
  }

  if (lista.total === 0) {
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Acervo</h1>
        <EmptyState
          titulo="O Acervo ainda está sendo montado"
          descricao="As primeiras Fontes aparecem aqui assim que forem publicadas."
          acao={
            <Button asChild variant="primary">
              <Link href="/trilhas">Ir para as Trilhas</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const aviso = parametroInvalido || lista.nivelSemFonte;

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Acervo</h1>
      <p className="text-leitura">{LEDE}</p>
      <CampoBuscaAcervo />
      {aviso ? (
        <StatusMessage tipo="informacao">
          Não há Fontes neste Nível ainda. Mostramos todas.
        </StatusMessage>
      ) : null}
      <FiltroNivel oferecidos={lista.oferecidos} selecionado={lista.nivelAplicado} />
      <p role="status" data-slot="contagem-acervo" className="text-meta text-ink-muted">
        {contagemEmTexto(lista.nivelAplicado, lista.totalMostrado)}
      </p>
      <div className="flex flex-col gap-8">
        {lista.grupos.map((g) => {
          const id = `grupo-${g.nivel}`;
          return (
            <section
              key={g.nivel}
              aria-labelledby={id}
              data-nivel={g.nivel}
              data-slot="grupo-nivel"
            >
              <h2 id={id} className="text-label">
                {NOME_DO_NIVEL[g.nivel]} <span data-slot="contagem-grupo">({g.fontes.length})</span>
              </h2>
              <p className="text-meta mb-2 text-ink-muted">{FRASE_DO_NIVEL[g.nivel]}</p>
              <ul>
                {g.fontes.map((f) => (
                  <LinhaFonte key={f.slug} fonte={f} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
