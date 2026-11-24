// Quantos versículos a Leitura de um Estudo tem, estimado SÓ pelas chaves das Passagens (nenhuma leitura de
// banco: o esqueleto "Carregando o texto…" é desenhado antes do texto e não pode esperar por ele). O número
// serve para reservar altura no esqueleto (ver `PassagemCarregando`); não aparece para ninguém, e por isso
// vale ser grosseiro, desde que NÃO passe do real: esqueleto mais alto que o texto faz o resto da página
// subir quando o texto chega, e mais baixo, descer; subir para dentro da tela é o pior dos dois.

import { decompor } from "@/modules/referencias/chave";

/** Versículos de um capítulo que se assume ao cruzar capítulo sem saber o tamanho (mediana baixa: 4 evangelhos e Paulo). */
const VERSICULOS_POR_CAPITULO_INTERMEDIARIO = 12;
/** Teto: um capítulo inteiro vem com `fim` no último versículo possível (999); o esqueleto já é limitado pela janela. */
const TETO = 60;

export function estimarVersiculos(passagens: readonly { inicio: number; fim: number }[]): number {
  let total = 0;
  for (const p of passagens) {
    let n: number;
    try {
      const a = decompor(p.inicio);
      const b = decompor(p.fim);
      n =
        a.livro === b.livro && a.capitulo === b.capitulo
          ? b.versiculo - a.versiculo + 1
          : // Cruza capítulo: a cauda do primeiro (no mínimo 1), os capítulos do meio e a cabeça do último.
            1 + (b.capitulo - a.capitulo - 1) * VERSICULOS_POR_CAPITULO_INTERMEDIARIO + b.versiculo;
    } catch {
      n = 0;
    }
    total += Math.max(0, Math.min(n, TETO));
  }
  return Math.min(total, TETO);
}
