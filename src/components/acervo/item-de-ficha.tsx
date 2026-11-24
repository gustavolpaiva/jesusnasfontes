import type { ItemLido, PaginaDoItem } from "@/modules/acervo/consultas-ficha";

// Um argumento ou um trecho de ficha (ACER-03, D-11, D-19). O texto em português entra em Corpo de leitura; o trecho
// original, quando há, vai abaixo em `<q lang>` com filete esquerdo de 2 px e recuo de 16 px (no máximo 300
// caracteres, imposto no banco); a página vai por último, em Rótulo. Toda afirmação de ficha mostra a página: item sem
// página não é renderizado. Tudo entra como texto React, nunca como marcação.

const TRAVESSAO = "–";

/** "p. 39", "p. 39–53", "p. xi–xii": o que se vê. Sem página, `null`. */
export function paginaVisivel(p: PaginaDoItem): string | null {
  if (p.inicio !== null) {
    const fim = p.fim ?? p.inicio;
    return fim === p.inicio ? `p. ${p.inicio}` : `p. ${p.inicio}${TRAVESSAO}${fim}`;
  }
  if (p.texto) return `p. ${p.texto.replace("-", TRAVESSAO)}`;
  return null;
}

/** "página 39 a 53": o que o leitor de tela lê no lugar de "p. 39–53". */
export function paginaFalada(p: PaginaDoItem): string | null {
  if (p.inicio !== null) {
    const fim = p.fim ?? p.inicio;
    return fim === p.inicio ? `página ${p.inicio}` : `página ${p.inicio} a ${fim}`;
  }
  if (p.texto) {
    const partes = p.texto.split("-");
    return partes.length === 2 ? `página ${partes[0]} a ${partes[1]}` : `página ${p.texto}`;
  }
  return null;
}

export function ItemDeFicha({ item }: { item: ItemLido }) {
  const visivel = paginaVisivel(item.pagina);
  const falada = paginaFalada(item.pagina);
  if (!visivel || !falada) return null;
  return (
    <div data-slot="item-de-ficha" className="flex flex-col gap-2">
      <p className="text-leitura [overflow-wrap:anywhere]">{item.textoPt}</p>
      {item.trechoOriginal ? (
        <q
          lang={item.idiomaTrecho ?? undefined}
          data-slot="trecho-original"
          className="text-leitura block border-l-2 border-ink pl-4 [overflow-wrap:anywhere]"
        >
          {item.trechoOriginal}
        </q>
      ) : null}
      <p
        data-slot="pagina-do-item"
        className="text-label text-ink-muted [font-variant-numeric:tabular-nums]"
      >
        <span aria-hidden="true">{visivel}</span>
        <span className="sr-only">{falada}</span>
      </p>
    </div>
  );
}
