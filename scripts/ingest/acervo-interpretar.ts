// Despachante de formatos do Acervo: a ÚNICA porta pela qual o derivador e o `acervo:verify` interpretam um
// arquivo bruto. O formato registrado na origem escolhe o verificador de licença e o parser; cada plano de
// origem acrescenta o seu formato aqui (`thml` no plano 08), sem tocar quem chama. A licença e o tradutor são
// conferidos ANTES de o corpo ser interpretado (D-06): um arquivo que não os prova nunca chega ao parser.
// Código de DESENVOLVEDOR; só `htmlparser2` por baixo, nenhuma rede.

import {
  type CabecalhoGutenberg,
  type CabecalhoHtml,
  type CabecalhoTei,
  exigirDedicacaoDominioPublico,
  exigirLicencaGutenberg,
  exigirTraducaoTei,
} from "./acervo-licenca";
import { ErroOrigem, FORMATOS_ORIGEM, type OrigemAcervo } from "./acervo-origens";
import { type ConfigGutenberg, parsearGutenberg } from "./acervo-parse-gutenberg";
import { type ConfigHtml, parsearHtml } from "./acervo-parse-html";
import { parsearTei, type SecaoTei } from "./acervo-parse-tei";

export type ConfigInterpretar = {
  /** Tradutores e licença que o cabeçalho do próprio arquivo tem de trazer (`verificador` da origem). */
  verificador: OrigemAcervo["verificador"];
  /** Rótulo do título da seção: "Book" dá "Book 18". */
  rotuloLivro?: string;
  /** Título da seção única de uma obra sem livros. */
  tituloObraUnica?: string;
  /** Formato `gutenberg`: a estrutura da obra, como o registro a descreve (`estrutura`, `secoes`, tabela). */
  gutenberg?: ConfigGutenberg;
  /** Formato `html`: a palavra que abre o cabeçalho de cada unidade (`rotulo_unidade`). */
  html?: ConfigHtml;
};

export type ResultadoInterpretado = {
  secoes: SecaoTei[];
  /** Notas de editor lidas à parte, para o derivador conferir que nenhuma entrou num parágrafo. */
  notas: string[];
  /** O que o próprio arquivo declarou (tradutores, licença, anos, aviso da edição). */
  cabecalho: CabecalhoTei | CabecalhoGutenberg | CabecalhoHtml;
  /** Unidades que a numeração do arquivo salta: a origem não as traz (só os formatos que numeram as unidades). */
  ausentes?: string[];
  /** Unidades fora da tabela de correspondência, que ficaram com a numeração da própria origem. */
  foraDaTabela?: string[];
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
    case "gutenberg": {
      // A licença vem das bordas do arquivo; só depois o corpo é lido.
      const cabecalho = exigirLicencaGutenberg(conteudo, config.verificador);
      if (!config.gutenberg)
        throw new ErroOrigem(
          "formato gutenberg exige a estrutura da obra no registro: `estrutura` e `secoes` de cada arquivo",
        );
      const { secoes, notas, ausentes, foraDaTabela } = parsearGutenberg(
        conteudo,
        config.gutenberg,
      );
      return { secoes, notas, cabecalho, ausentes, foraDaTabela };
    }
    case "html": {
      const cabecalho = exigirDedicacaoDominioPublico(conteudo, config.verificador);
      if (!config.html)
        throw new ErroOrigem("formato html exige `rotulo_unidade` no registro de cada arquivo");
      const { secoes, notas } = parsearHtml(conteudo, config.html);
      return { secoes, notas, cabecalho };
    }
    default:
      if ((FORMATOS_ORIGEM as readonly string[]).includes(formato))
        throw new ErroOrigem(
          `formato "${formato}" está registrado, mas ainda está sem verificador de licença e sem parser neste pipeline: nenhum derivado sai dele`,
        );
      throw new ErroOrigem(
        `formato de origem desconhecido: "${formato}" (registrados: ${FORMATOS_ORIGEM.join(", ")})`,
      );
  }
}
