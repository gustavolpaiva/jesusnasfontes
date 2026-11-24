import Link from "next/link";
import { Algarismos } from "@/components/ui/algarismos";
import type { EntradaDoCaderno } from "@/modules/caderno/caderno";
import { dividirTrecho } from "@/modules/caderno/trecho";
import { formatarData, formatarHora, mesmoDia } from "@/modules/sessao/formato";

// Uma entrada do Caderno (tela 10): eyebrow com a data, o título do Estudo (link) ou o intervalo da Sessão
// (sem link), e o trecho em até 3 linhas. Entradas separadas por filete, sem cartão. O trecho é TEXTO da
// pessoa: as palavras achadas viram `<mark>` (sem fundo: peso 600 e sublinhado de 2 px na rubrica, então o
// destaque não depende de cor) e todo o resto entra como texto, nunca como HTML.

function eyebrow(e: EntradaDoCaderno): string {
  const inicio = new Date(e.em);
  if (e.tipo === "anotacao") return `atualizada em ${formatarData(inicio)}`;
  const fim = e.fimEm ? new Date(e.fimEm) : inicio;
  const intervalo = mesmoDia(inicio, fim)
    ? `${formatarData(inicio)}, ${formatarHora(inicio)} a ${formatarHora(fim)}`
    : `${formatarData(inicio)}, ${formatarHora(inicio)} a ${formatarData(fim)}, ${formatarHora(fim)}`;
  return `Anotação da Sessão · ${intervalo}`;
}

export function EntradaCaderno({ entrada }: { entrada: EntradaDoCaderno }) {
  const partes = dividirTrecho(entrada.trecho);
  return (
    <li
      data-slot="entrada-caderno"
      data-tipo={entrada.tipo}
      className="flex flex-col gap-2 border-b border-rule py-4 last:border-b-0"
    >
      <p className="text-label text-rubric">
        <Algarismos>{eyebrow(entrada)}</Algarismos>
      </p>
      {entrada.tipo === "anotacao" && entrada.slug ? (
        <h2 className="text-heading text-balance [overflow-wrap:anywhere]">
          <Link
            href={`/estudos/${entrada.slug}`}
            // A margem negativa com o respiro de mesmo tamanho dá ao link o alvo de 44 px sem mudar o desenho da entrada.
            className="-my-2 block rounded-sm py-2 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {entrada.titulo}
          </Link>
        </h2>
      ) : (
        <h2 className="text-heading text-balance [overflow-wrap:anywhere]">
          de {entrada.de} até {entrada.ate}
        </h2>
      )}
      <p className="text-leitura line-clamp-3 whitespace-pre-line [overflow-wrap:anywhere]">
        {partes.map((p, i) =>
          p.achado ? (
            <mark
              // biome-ignore lint/suspicious/noArrayIndexKey: trechos fixos nesta renderização
              key={i}
              className="bg-transparent font-semibold text-inherit underline decoration-rubric decoration-2 underline-offset-4"
            >
              {p.texto}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: trechos fixos nesta renderização
            <span key={i}>{p.texto}</span>
          ),
        )}
      </p>
    </li>
  );
}
