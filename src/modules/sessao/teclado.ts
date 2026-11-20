// O teclado de tela do celular encolhe a área VISÍVEL (visualViewport) sem encolher a janela de layout:
// uma folha presa à base da janela fica atrás do teclado. Esta conta devolve, para a folha de baixo, a
// altura máxima e o quanto subir para ficar inteira dentro da área visível. Sem teclado, a altura visível
// é a da janela e o deslocamento é zero. Pura, para o teste de unidade a provar sem navegador.

export type AreaVisivel = { height: number; offsetTop: number };

export type PosicaoDaFolha = { alturaMaxima: number; deslocamentoDaBase: number };

export function posicaoDaFolha(alturaDaJanela: number, visivel: AreaVisivel): PosicaoDaFolha {
  // O que está abaixo da área visível (o teclado) e o quanto a área visível desceu (rolagem do viewport).
  const abaixo = alturaDaJanela - (visivel.height + visivel.offsetTop);
  return {
    alturaMaxima: Math.max(0, Math.round(visivel.height)),
    deslocamentoDaBase: Math.max(0, Math.round(abaixo)),
  };
}
