// Extração das Afirmações do corpo em Markdown (TRIL-07). A Afirmação é marcada no texto com a
// diretiva de texto `:afirmacao[frase]{#id}`; o id é autoral, estável e nunca reutilizado. A leitura
// usa unified, remark-parse e remark-directive e não executa nada do conteúdo.

import { createHash } from "node:crypto";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Prefixo do Estudo (bh = Base histórica, pc = Pontos centrais), número do Estudo e ordinal. */
export const PADRAO_ID_AFIRMACAO = /^(bh|pc)[0-9]{2}-a[0-9]+$/;

// Erro nosso, com texto seguro (ids e trechos curtos do próprio conteúdo): pode ir ao terminal.
export class ErroAfirmacao extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroAfirmacao";
  }
}

export type AfirmacaoExtraida = {
  id: string;
  texto: string;
  /** Posição entre as Afirmações do Estudo, a partir de 1. */
  ordem: number;
  /** Parágrafo que a contém (item de lista inclusive): Afirmações do mesmo bloco têm o mesmo número. */
  bloco: number;
};

type No = {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: No[];
  value?: string;
};

function textoPuro(no: No): string {
  if (typeof no.value === "string" && (no.type === "text" || no.type === "inlineCode"))
    return no.value;
  return (no.children ?? []).map(textoPuro).join("");
}

/** Hash do texto da Afirmação: muda quando o texto muda. */
export function textoDaAfirmacao(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

const resumo = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/** As Afirmações do corpo, na ordem em que aparecem. Falha em id repetido ou fora do padrão. */
export function extrairAfirmacoes(corpoMd: string): AfirmacaoExtraida[] {
  const raiz = unified().use(remarkParse).use(remarkDirective).parse(corpoMd) as unknown as No;
  const achadas: AfirmacaoExtraida[] = [];
  const ids = new Set<string>();
  let paragrafos = 0;

  const andar = (no: No, bloco: number | null, dentroDeAfirmacao: boolean): void => {
    if (no.type === "leafDirective" || no.type === "containerDirective")
      throw new ErroAfirmacao(
        `só a diretiva de texto :afirmacao[frase]{#id} é aceita (achada ${no.type === "leafDirective" ? "::" : ":::"}${no.name ?? ""})`,
      );
    if (no.type === "textDirective") {
      if (no.name !== "afirmacao") {
        // A11: o remark-directive lê como diretiva de texto qualquer ":nome" sem letra ou dígito
        // antes do nome ("3:13" de "Mt 3:13" vira a diretiva "13"). Sem rótulo e sem atributos é só
        // um dois-pontos do texto e segue como está; com rótulo ou atributos é diretiva de verdade.
        if ((no.children?.length ?? 0) > 0 || Object.keys(no.attributes ?? {}).length > 0)
          throw new ErroAfirmacao(`diretiva desconhecida: :${no.name ?? ""}`);
        return;
      }
      if (dentroDeAfirmacao)
        throw new ErroAfirmacao("Afirmação dentro de outra Afirmação");
      const atributos = no.attributes ?? {};
      const id = atributos.id;
      if (!id) throw new ErroAfirmacao(`Afirmação sem id: "${resumo(textoPuro(no))}"`);
      const outros = Object.keys(atributos).filter((k) => k !== "id");
      if (outros.length > 0)
        throw new ErroAfirmacao(`${id}: atributo não aceito (${outros.join(", ")})`);
      if (!PADRAO_ID_AFIRMACAO.test(id))
        throw new ErroAfirmacao(`id fora do padrão ${PADRAO_ID_AFIRMACAO}: ${id}`);
      if (ids.has(id)) throw new ErroAfirmacao(`id repetido: ${id}`);
      if (bloco === null) throw new ErroAfirmacao(`${id}: Afirmação fora de parágrafo`);
      const texto = textoPuro(no).trim();
      if (texto === "") throw new ErroAfirmacao(`${id}: Afirmação vazia`);
      ids.add(id);
      achadas.push({ id, texto, ordem: achadas.length + 1, bloco });
      for (const filho of no.children ?? []) andar(filho, bloco, true);
      return;
    }
    const proximoBloco = no.type === "paragraph" ? ++paragrafos : bloco;
    for (const filho of no.children ?? []) andar(filho, proximoBloco, dentroDeAfirmacao);
  };

  andar(raiz, null, false);
  return achadas;
}
