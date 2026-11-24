// Despachante de formatos do Acervo: a ÚNICA porta pela qual o derivador e o `acervo:verify` interpretam um
// arquivo bruto. O formato registrado na origem escolhe o verificador de licença e o parser; cada plano de
// origem acrescenta o seu formato aqui (`gutenberg` e `html` no plano 27, `thml` no plano 08), sem tocar quem
// chama. A licença e o tradutor são conferidos ANTES de o corpo ser interpretado (D-06): um cabeçalho que não
// confere nunca chega ao parser. Código de DESENVOLVEDOR; só `htmlparser2` por baixo, nenhuma rede.

import { type CabecalhoTei, exigirTraducaoTei } from "./acervo-licenca";
import { ErroOrigem, FORMATOS_ORIGEM, type OrigemAcervo } from "./acervo-origens";
import { parsearTei, type SecaoTei } from "./acervo-parse-tei";

export type ConfigInterpretar = {
  /** Tradutores e licença que o cabeçalho do próprio arquivo tem de trazer (`verificador` da origem). */
  verificador: OrigemAcervo["verificador"];
  /** Rótulo do título da seção: "Book" dá "Book 18". */
  rotuloLivro?: string;
  /** Título da seção única de uma obra sem livros. */
  tituloObraUnica?: string;
};

export type ResultadoInterpretado = {
  secoes: SecaoTei[];
  /** Notas de editor lidas à parte, para o derivador conferir que nenhuma entrou num parágrafo. */
  notas: string[];
  /** O que o cabeçalho do arquivo declarou (tradutores, licença, anos, aviso da edição). */
  cabecalho: CabecalhoTei;
};

/** Interpreta o conteúdo bruto de um arquivo de origem conforme o formato registrado. */
export function interpretarOrigem(
  formato: string,
  conteudo: string,
  config: ConfigInterpretar,
): ResultadoInterpretado {
  switch (formato) {
    case "tei": {
      const cabecalho = exigirTraducaoTei(conteudo, config.verificador);
      const { secoes, notas } = parsearTei(conteudo, {
        rotuloLivro: config.rotuloLivro,
        tituloObraUnica: config.tituloObraUnica,
      });
      return { secoes, notas, cabecalho };
    }
    default:
      throw new ErroOrigem(
        `formato de origem desconhecido: "${formato}" (conhecidos: ${FORMATOS_ORIGEM.join(", ")})`,
      );
  }
}
