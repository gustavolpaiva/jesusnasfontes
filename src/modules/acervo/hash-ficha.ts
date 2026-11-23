import { createHash } from "node:crypto";
import { type FichaYaml, interpretarPagina, type PaginaInterpretada } from "./schemas";

// Hash canônico da ficha e dos itens. A verificação de uma ficha é uma EVIDÊNCIA amarrada a este hash: mudou o
// conteúdo, mudou o hash, e a verificação deixa de valer em silêncio. O texto do rascunho e a página fazem parte
// do hash; a confiança do rascunho e `serve_a` (que só serve ao planejamento) não fazem. O mesmo estilo de
// `textoDaAfirmacao`: sha256 de uma serialização fixa, com versão no começo para o formato poder evoluir.

export type ItemDaFicha = {
  /** `<slug>/<tipo>-<n>`: o n é a posição do item dentro do tipo, a partir de 1. */
  id: string;
  tipo: "argumento" | "trecho";
  /** Posição dentro do tipo (a mesma do id). */
  ordem: number;
  texto_pt: string;
  pagina: PaginaInterpretada;
  trecho_original: string | null;
  idioma_trecho: "pt" | "en" | null;
  confianca: "alta" | "media" | "baixa";
};

const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex");

/** Os itens da ficha com id e posição, argumentos primeiro e trechos depois, cada tipo na ordem do YAML. */
export function itensDaFicha(ficha: FichaYaml): ItemDaFicha[] {
  const itens: ItemDaFicha[] = [];
  for (const tipo of ["argumento", "trecho"] as const) {
    let ordem = 0;
    for (const item of ficha.itens) {
      if (item.tipo !== tipo) continue;
      ordem++;
      const trecho = item.trecho_original ?? null;
      itens.push({
        id: `${ficha.slug}/${tipo}-${ordem}`,
        tipo,
        ordem,
        texto_pt: item.texto_pt,
        pagina: interpretarPagina(item.pagina),
        trecho_original: trecho,
        // O idioma do trecho é o da ficha; sem trecho, não há idioma a guardar.
        idioma_trecho: trecho === null ? null : ficha.idioma_trechos,
        confianca: item.confianca,
      });
    }
  }
  return itens;
}

const paginaCanonica = (p: PaginaInterpretada): string =>
  p.inicio !== null ? `n:${p.inicio}-${p.fim}` : `t:${p.texto}`;

export function hashDoItem(item: ItemDaFicha): string {
  return sha256(
    JSON.stringify([
      "jnf-ficha-item-v1",
      item.tipo,
      item.texto_pt,
      paginaCanonica(item.pagina),
      item.trecho_original,
      item.idioma_trecho,
    ]),
  );
}

/** Hash do conteúdo canônico da ficha: os campos dela, os da Fonte que a descrevem e os itens, em ordem. */
export function hashDaFicha(ficha: FichaYaml, itens: readonly ItemDaFicha[]): string {
  return sha256(
    JSON.stringify([
      "jnf-ficha-v1",
      ficha.slug,
      ficha.titulo,
      ficha.autor,
      ficha.ano,
      ficha.editora ?? null,
      ficha.edicao_consultada,
      ficha.tese_pt,
      ficha.limites_pt ?? null,
      ficha.idioma_trechos,
      itens.map((i) => [i.id, hashDoItem(i)]),
    ]),
  );
}
