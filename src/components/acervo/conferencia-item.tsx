import type { ReactNode } from "react";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { paginaFalada, paginaVisivel } from "@/components/acervo/item-de-ficha";
import { Algarismos } from "@/components/ui/algarismos";
import type { ItemParaConferir } from "@/modules/acervo/consultas-admin";
import { dataCurta } from "@/modules/acervo/painel-fichas";

// A linha de conferência de um item com página (UI-SPEC tela 12, ACER-07): a página em Rótulo, a edição consultada em
// meta, o estado ("A conferir" tracejado ou "Conferida em {data}" sólido com `check`) e, enquanto falta conferir, o
// botão "Conferi no livro" (o `acao`, que é uma ilha de cliente). Conferida não tem botão: o ato não se desfaz nesta fase.
// O nome acessível do botão leva a página falada ("Conferi a página 39 a 53 no livro"); o leitor de tela lê a linha
// como uma região com o mesmo nome.

export function ConferenciaItem({
  item,
  edicao,
  acao,
}: {
  item: Pick<ItemParaConferir, "id" | "pagina" | "conferidaEm">;
  edicao: string;
  /** O botão "Conferi no livro"; só passa quando a página ainda está por conferir. */
  acao?: ReactNode;
}) {
  const visivel = paginaVisivel(item.pagina);
  const falada = paginaFalada(item.pagina);
  if (!visivel || !falada) return null;
  const conferida = item.conferidaEm !== null;
  return (
    <fieldset
      data-slot="conferencia-item"
      data-item={item.id}
      data-estado={conferida ? "conferida" : "a-conferir"}
      className="m-0 flex min-w-0 flex-col gap-3 border-0 border-t border-rule p-0 pt-3"
    >
      <legend className="sr-only">{`Conferência da ${falada}`}</legend>
      <p className="flex flex-col gap-1">
        <span className="text-label [font-variant-numeric:tabular-nums]">
          <span aria-hidden="true">
            <Algarismos>{visivel}</Algarismos>
          </span>
          <span className="sr-only">{falada}</span>
        </span>
        <span className="text-meta text-ink-muted [overflow-wrap:anywhere]">
          conferir na edição: {edicao}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {conferida && item.conferidaEm ? (
          <ChipEstado tom="concluido">{`Conferida em ${dataCurta(item.conferidaEm)}`}</ChipEstado>
        ) : (
          <ChipEstado tom="pendente">A conferir</ChipEstado>
        )}
        {conferida ? null : acao}
      </div>
    </fieldset>
  );
}
