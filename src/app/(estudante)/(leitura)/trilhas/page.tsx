import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { lerPrimeiroEstudo } from "@/modules/conteudo/estudo";
import { exigirSessao } from "@/modules/identidade/sessao";
import { listarTrilhas, TRILHA_LEITURA_CONTINUA } from "@/modules/trilhas/consultas";
import { EstudoRow } from "@/modules/trilhas/estudo-row";
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

export default async function PaginaTrilhas() {
  const { usuario } = await exigirSessao();
  const [posicao, trilhas] = await Promise.all([
    lerUltimaPosicao(usuario.id),
    listarTrilhas(usuario.id),
  ]);
  // Quem ainda não abriu nenhum Estudo começa pelo primeiro, na ordem das Trilhas e dos Estudos.
  const primeiro = posicao ? null : await lerPrimeiroEstudo();
  const destino = posicao ?? primeiro;

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Trilhas</h1>
      <p className="text-leitura">
        Três caminhos em sequência: a base histórica, os pontos centrais e a leitura capítulo a
        capítulo. Até 10 minutos por Estudo, sem data para acabar.
      </p>
      {destino ? (
        <section
          aria-labelledby="retomar-rotulo"
          className="flex flex-col items-start gap-3 border-y border-rule py-6"
        >
          <p id="retomar-rotulo" className="text-label text-rubric">
            {posicao ? "Continuar de onde parei" : "Começar"}
          </p>
          {posicao ? <p className="text-heading">{posicao.titulo}</p> : null}
          <Button asChild variant="primary">
            <Link href={`/estudos/${destino.slug}`}>
              {posicao ? "Continuar" : "Começar pelo primeiro Estudo"}
            </Link>
          </Button>
        </section>
      ) : null}
      {/* Título só para o leitor de tela: sem ele a lista salta de h1 para h3 (cada gatilho é um h3). */}
      <h2 className="sr-only">Escolha uma Trilha</h2>
      <Accordion type="multiple" defaultValue={posicao ? [posicao.trilhaId] : []}>
        {trilhas.map((t) => (
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
              volta={t.id === TRILHA_LEITURA_CONTINUA ? t.volta : undefined}
            />
            <AccordionContent>
              <p className="text-meta mb-3 text-ink-muted">{t.descricao}</p>
              {emGrupos(t.estudos).map((g) => (
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
              ))}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
