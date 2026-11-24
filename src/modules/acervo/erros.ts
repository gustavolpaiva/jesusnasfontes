// Erros tipados da verificação de fichas (ACER-07). O banco os levanta com SQLSTATE próprio (migração 0020) e a camada
// de aplicação os traduz: o texto do erro do banco nunca chega aqui nem à tela.

/** 42501: a sessão não é de um Admin com segundo fator verificado na geração atual (a tela pede para confirmar). */
export class SegundoFatorVencido extends Error {
  constructor() {
    super("segundo fator ausente ou vencido");
    this.name = "SegundoFatorVencido";
  }
}

/** 40001: o item ou a ficha mudou desde a leitura (o hash enviado não é o atual), ou deixou de existir. */
export class ConteudoMudou extends Error {
  constructor() {
    super("o conteúdo mudou desde a leitura");
    this.name = "ConteudoMudou";
  }
}

/** P0001: ainda há páginas sem conferência do hash atual; `faltam` é a contagem que o banco informou. */
export class FaltamPaginas extends Error {
  readonly faltam: number;
  constructor(faltam: number) {
    super(`faltam ${faltam} páginas a conferir`);
    this.name = "FaltamPaginas";
    this.faltam = faltam;
  }
}

/** P0002: a edição consultada ainda é "A confirmar"; a página só vale para uma edição declarada. */
export class EdicaoNaoConfirmada extends Error {
  constructor() {
    super("a edição consultada ainda não foi confirmada");
    this.name = "EdicaoNaoConfirmada";
  }
}
