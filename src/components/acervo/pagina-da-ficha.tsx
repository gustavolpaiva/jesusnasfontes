import { ArrowLeft, Check } from "lucide-react";
import Link from "next/link";
import { ItemDeFicha } from "@/components/acervo/item-de-ficha";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { Button } from "@/components/ui/button";
import type { FichaLida } from "@/modules/acervo/consultas-ficha";

// Tela da ficha de uma obra da Pesquisa acadêmica (UI-SPEC tela 6; ACER-03, ACER-07, D-05, D-11). Só chega aqui ficha
// verificada: rascunho e ficha alterada depois de verificada dão "Página não encontrada" antes deste componente.
// "Verificada em {data}" nunca traz o nome de quem verificou; a edição consultada aparece sempre, porque a página só
// vale para essa edição. Seção sem conteúdo não é renderizada e não deixa título solto. A ficha não tem capitular.

const FUSO = "America/Sao_Paulo";
const DATA_POR_EXTENSO = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: FUSO });

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

export function PaginaDaFicha({
  ficha,
  linkDaCarta = false,
}: {
  ficha: FichaLida;
  /** Só quando a carta de neutralidade está publicada (D-08): o link nunca leva a uma página vazia. */
  linkDaCarta?: boolean;
}) {
  const meta = [ficha.autor, ficha.ano === null ? null : String(ficha.ano), ficha.editora]
    .filter(Boolean)
    .join(", ");
  const temCitacao = [...ficha.argumentos, ...ficha.trechos].some((i) => i.trechoOriginal);

  return (
    <article data-slot="ficha" className="coluna-leitura flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <Button asChild variant="ghost" className="-ml-4">
          <Link href="/acervo">
            <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
            Voltar ao Acervo
          </Link>
        </Button>
        <p className="text-label text-rubric">Ficha</p>
        <h1 className="text-display text-balance [overflow-wrap:anywhere]">{ficha.titulo}</h1>
        {meta ? <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">{meta}</p> : null}
        <SeloNivel nivel="academica" />
      </header>

      <div data-slot="verificacao" className="flex flex-col gap-1">
        <p className="text-label flex items-center gap-2">
          <Check aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />
          <span>
            Verificada em{" "}
            <time dateTime={ficha.verificadaEm.toISOString()}>
              {DATA_POR_EXTENSO.format(ficha.verificadaEm)}
            </time>
          </span>
        </p>
        <p className="text-meta text-ink-muted">
          Cada página citada foi conferida no livro por um Admin.
        </p>
      </div>

      <dl data-slot="edicao-consultada" className="flex flex-col gap-1 border-y border-rule py-3">
        <dt className="text-label text-ink-muted">Edição consultada</dt>
        <dd className="text-ui [overflow-wrap:anywhere]">{ficha.edicaoConsultada}</dd>
      </dl>

      <p className="text-meta text-ink-muted">
        Esta ficha resume a obra. As frases entre aspas são citações curtas, cada uma com a sua
        página.
      </p>

      <Secao id="ficha-tese" titulo="Tese">
        <p className="text-leitura [overflow-wrap:anywhere]">{ficha.tesePt}</p>
      </Secao>

      {ficha.argumentos.length > 0 ? (
        <Secao id="ficha-argumentos" titulo="Argumentos">
          <ol className="flex list-decimal flex-col gap-6 pl-6 marker:text-ink-muted">
            {ficha.argumentos.map((item) => (
              <li key={item.id}>
                <ItemDeFicha item={item} />
              </li>
            ))}
          </ol>
        </Secao>
      ) : null}

      {ficha.trechos.length > 0 ? (
        <Secao id="ficha-trechos" titulo="Trechos citados">
          <ul className="flex flex-col gap-6">
            {ficha.trechos.map((item) => (
              <li key={item.id}>
                <ItemDeFicha item={item} />
              </li>
            ))}
          </ul>
        </Secao>
      ) : null}

      {ficha.limitesPt ? (
        <Secao id="ficha-limites" titulo="O que esta obra não pode dizer">
          <p className="text-leitura [overflow-wrap:anywhere]">{ficha.limitesPt}</p>
        </Secao>
      ) : null}

      {linkDaCarta || temCitacao ? (
        <footer
          data-slot="rodape-da-ficha"
          className="flex flex-col gap-2 border-t border-rule pt-4"
        >
          {linkDaCarta ? (
            <p>
              <Link
                href="/acervo/carta-de-neutralidade"
                className="text-ui inline-flex min-h-11 items-center text-rubric underline"
              >
                Por que estas obras? Leia a carta de neutralidade.
              </Link>
            </p>
          ) : null}
          {temCitacao ? (
            <p className="text-meta text-ink-muted">
              Trechos entre aspas pertencem aos autores citados.
            </p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
