import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { ChipDaFicha } from "@/components/acervo/chip-da-ficha";
import { ConferenciaItem } from "@/components/acervo/conferencia-item";
import { ItemDeFicha, paginaFalada } from "@/components/acervo/item-de-ficha";
import { ProgressoDaFicha } from "@/components/acervo/progresso-da-ficha";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type FichaParaAdmin, lerFichaParaAdmin } from "@/modules/acervo/consultas-admin";
import { faltam } from "@/modules/acervo/estado-da-ficha";
import { MENSAGENS_FICHA } from "@/modules/acervo/painel-fichas";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { ConferirBotao } from "./conferir-botao";
import { ProvedorDeConferencia } from "./estado-da-conferencia";
import { VerificarBloco } from "./verificar-bloco";

// Detalhe da ficha para o Admin (ACER-07, D-02, D-03, UI-SPEC tela 12): o conteúdo INTEIRO no tamanho de leitura, na
// estrutura da tela da ficha do Estudante (Tese, Argumentos, Trechos citados, limites), a linha de conferência sob cada
// item com página e o ato de verificar no fim. É o único caminho pelo qual uma ficha chega ao Estudante. A página não
// mostra quem verificou (D-05): o nome mora só no registro interno do banco.
export const dynamic = "force-dynamic";
export const metadata = { title: "Ficha a verificar" };

const FILA = "/admin/acervo/fichas";

function Secao({
  id,
  titulo,
  children,
}: {
  id: string;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-slot="secao-da-ficha" className="flex flex-col gap-3">
      <h2 id={id} className="text-label text-ink-muted">
        {titulo}
      </h2>
      {children}
    </section>
  );
}

function ItemComConferencia({
  f,
  item,
}: {
  f: FichaParaAdmin;
  item: FichaParaAdmin["argumentos"][number];
}) {
  const falada = paginaFalada(item.pagina);
  return (
    <div className="flex flex-col gap-3" data-slot="item-a-conferir">
      <ItemDeFicha item={item} />
      <ConferenciaItem
        item={item}
        edicao={f.edicaoConsultada}
        acao={
          falada ? (
            <ConferirBotao slug={f.slug} itemId={item.id} hash={item.hash} paginaFalada={falada} />
          ) : null
        }
      />
    </div>
  );
}

export default async function PaginaDaFichaDoAdmin({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // A guarda vem antes de tudo: quem não é Admin com segundo fator recebe a 404 (ou a tela do segundo fator).
  const sessao = await exigirAdmin();
  const { slug } = await params;

  let f: FichaParaAdmin | null;
  try {
    f = await lerFichaParaAdmin(sessao.sessao.id, slug);
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-ficha-detalhe", erro);
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Ficha a verificar</h1>
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <Link href={`${FILA}/${slug}`}>{MENSAGENS_FICHA.tentarDeNovo}</Link>
            </Button>
          }
        >
          Não conseguimos carregar a ficha. Tente de novo.
        </StatusMessage>
      </div>
    );
  }
  if (!f) notFound();

  const meta = [f.autor, f.ano === null ? null : String(f.ano), f.editora]
    .filter(Boolean)
    .join(", ");
  const falta = faltam(f.conferidos, f.total);

  return (
    <ProvedorDeConferencia>
      <article data-slot="ficha-admin" className="coluna-leitura flex flex-col gap-8">
        <header className="flex flex-col items-start gap-3">
          <Button asChild variant="ghost" className="-ml-4">
            <Link href={FILA}>Voltar às fichas</Link>
          </Button>
          <p className="text-label text-rubric">Ficha</p>
          <h1 className="text-display text-balance [overflow-wrap:anywhere]">{f.titulo}</h1>
          {meta ? (
            <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">{meta}</p>
          ) : null}
          <SeloNivel nivel="academica" />
          <div className="flex w-full flex-col gap-2">
            <ChipDaFicha estado={f.estado} verificadaEm={f.verificadaEm} />
            <ProgressoDaFicha conferidos={f.conferidos} total={f.total} titulo={f.titulo} />
          </div>
        </header>

        {f.estado !== "verificada" ? (
          <StatusMessage tipo="informacao">{MENSAGENS_FICHA.rascunho}</StatusMessage>
        ) : null}

        <dl data-slot="edicao-consultada" className="flex flex-col gap-1 border-y border-rule py-3">
          <dt className="text-label text-ink-muted">Edição consultada</dt>
          <dd className="text-ui [overflow-wrap:anywhere]">{f.edicaoConsultada}</dd>
        </dl>

        <Secao id="ficha-tese" titulo="Tese">
          <p className="text-leitura [overflow-wrap:anywhere]">{f.tesePt}</p>
        </Secao>

        {f.argumentos.length > 0 ? (
          <Secao id="ficha-argumentos" titulo="Argumentos">
            <ol className="flex list-decimal flex-col gap-8 pl-6 marker:text-ink-muted">
              {f.argumentos.map((item) => (
                <li key={item.id}>
                  <ItemComConferencia f={f} item={item} />
                </li>
              ))}
            </ol>
          </Secao>
        ) : null}

        {f.trechos.length > 0 ? (
          <Secao id="ficha-trechos" titulo="Trechos citados">
            <ul className="flex flex-col gap-8">
              {f.trechos.map((item) => (
                <li key={item.id}>
                  <ItemComConferencia f={f} item={item} />
                </li>
              ))}
            </ul>
          </Secao>
        ) : null}

        {f.limitesPt ? (
          <Secao id="ficha-limites" titulo="O que esta obra não pode dizer">
            <p className="text-leitura [overflow-wrap:anywhere]">{f.limitesPt}</p>
          </Secao>
        ) : null}

        <VerificarBloco
          slug={f.slug}
          fichaId={f.fonteId}
          hash={f.hash}
          faltam={falta}
          edicaoConfirmada={f.edicaoConfirmada}
          verificadaEm={f.verificadaEm ? f.verificadaEm.toISOString() : null}
        />
      </article>
    </ProvedorDeConferencia>
  );
}
