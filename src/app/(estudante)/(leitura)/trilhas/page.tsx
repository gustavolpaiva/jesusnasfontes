import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { registrarErro } from "@/lib/registro";
import { lerPrimeiroEstudo } from "@/modules/conteudo/estudo";
import { exigirSessao } from "@/modules/identidade/sessao";
import { LIVROS } from "@/modules/referencias";
import { CapituloGrid } from "@/modules/trilhas/capitulo-grid";
import {
  lerPosicoesPorTrilha,
  listarTrilhas,
  TRILHA_LEITURA_CONTINUA,
  type TrilhaComEstudos,
} from "@/modules/trilhas/consultas";
import { Continuar } from "@/modules/trilhas/continuar";
import { EstudoRow } from "@/modules/trilhas/estudo-row";
import { ErroDasTrilhas, NovaVolta } from "@/modules/trilhas/nova-volta";
import { lerUltimaPosicao } from "@/modules/trilhas/posicao";
import { ProgressRule } from "@/modules/trilhas/progress-rule";

// Cada pessoa vê a SUA posição e o SEU progresso: a leitura passa por `comEstudante` com o id da sessão.
export const dynamic = "force-dynamic";

// Estudos de uma Trilha em ordem, agrupados pelo `grupo` quando houver (Pontos centrais).
function emGrupos<T extends { grupo: string | null }>(
  estudos: T[],
): { grupo: string | null; itens: T[] }[] {
  const grupos: { grupo: string | null; itens: T[] }[] = [];
  for (const e of estudos) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.grupo === e.grupo) ultimo.itens.push(e);
    else grupos.push({ grupo: e.grupo, itens: [e] });
  }
  return grupos;
}

// Leitura contínua: um grupo por livro que tenha capítulos (Mateus, Marcos, Lucas, João), na ordem da Bíblia.
function porLivro(t: TrilhaComEstudos, atualId: string | undefined) {
  const livros = new Map<
    number,
    {
      nome: string;
      casas: { slug: string; capitulo: number; concluido: boolean; atual: boolean }[];
    }
  >();
  for (const e of t.estudos) {
    if (e.livro === null || e.capitulo === null) continue;
    const grupo = livros.get(e.livro) ?? {
      nome: LIVROS.find((l) => l.numero === e.livro)?.nome ?? "",
      casas: [],
    };
    grupo.casas.push({
      slug: e.slug,
      capitulo: e.capitulo,
      concluido: e.concluido,
      atual: e.id === atualId,
    });
    livros.set(e.livro, grupo);
  }
  return [...livros.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, g]) => ({ ...g, casas: g.casas.sort((a, b) => a.capitulo - b.capitulo) }));
}

export default async function PaginaTrilhas() {
  const { usuario } = await exigirSessao();
  let dados: Awaited<ReturnType<typeof carregar>>;
  try {
    dados = await carregar(usuario.id);
  } catch (erro) {
    // Só o contexto, o código e a classe vão para o registro: o erro do banco não entra nele.
    registrarErro("trilhas-carga", erro);
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Trilhas</h1>
        <ErroDasTrilhas />
      </div>
    );
  }
  const { posicao, primeiro, trilhas, atualPorTrilha } = dados;

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Trilhas</h1>
      <p className="text-leitura">
        Três caminhos em sequência: a base histórica, os pontos centrais e a leitura capítulo a
        capítulo. Até 10 minutos por Estudo, sem data para acabar.
      </p>
      <Continuar posicao={posicao} primeiro={primeiro} />
      {/* Título só para o leitor de tela: sem ele a lista salta de h1 para h3 (cada gatilho é um h3). */}
      <h2 className="sr-only">Escolha uma Trilha</h2>
      <Accordion type="multiple" defaultValue={posicao ? [posicao.trilhaId] : []}>
        {trilhas.map((t) => {
          const leitura = t.id === TRILHA_LEITURA_CONTINUA;
          return (
            <AccordionItem key={t.id} value={t.id} data-trilha={t.id}>
              <AccordionTrigger>
                <span className="text-heading">
                  {t.ordem}. {t.nome}
                </span>
                <span className="text-label ml-auto text-ink-muted">
                  {t.concluidos} de {t.total}
                </span>
              </AccordionTrigger>
              <ProgressRule
                concluidos={t.concluidos}
                total={t.total}
                trilha={t.nome}
                volta={leitura ? t.volta : undefined}
              />
              <AccordionContent>
                <p className="text-meta mb-3 text-ink-muted">{t.descricao}</p>
                {leitura ? (
                  <>
                    {porLivro(t, atualPorTrilha.get(t.id)).map((g) => (
                      <div key={g.nome} className="flex flex-col gap-2 pb-4">
                        <h4 className="text-label mt-2 text-ink-muted">{g.nome}</h4>
                        <CapituloGrid livro={g.nome} casas={g.casas} />
                      </div>
                    ))}
                    {t.total > 0 && t.concluidos === t.total ? <NovaVolta volta={t.volta} /> : null}
                  </>
                ) : (
                  emGrupos(t.estudos).map((g) => (
                    <div key={g.grupo ?? "sem-grupo"} className="flex flex-col">
                      {g.grupo ? (
                        <h4 className="text-label mt-4 mb-1 text-ink-muted">{g.grupo}</h4>
                      ) : null}
                      <ul>
                        {g.itens.map((e) => (
                          <EstudoRow
                            key={e.id}
                            numero={e.ordem}
                            slug={e.slug}
                            titulo={e.titulo}
                            concluido={e.concluido}
                          />
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

async function carregar(estudanteId: string) {
  const [posicao, trilhas, posicoes] = await Promise.all([
    lerUltimaPosicao(estudanteId),
    listarTrilhas(estudanteId),
    lerPosicoesPorTrilha(estudanteId),
  ]);
  // Quem ainda não abriu nenhum Estudo começa pelo primeiro, na ordem das Trilhas e dos Estudos.
  const primeiro = posicao ? null : await lerPrimeiroEstudo();
  return { posicao, primeiro, trilhas, atualPorTrilha: posicoes };
}
