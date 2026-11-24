// Os cinco estados de uma ficha no painel do Admin (ACER-07, UI-SPEC tela 12). São DERIVADOS, nunca gravados: a
// ficha em si não tem coluna de estado; o que existe no banco são as conferências (uma por item, amarrada ao hash do
// item) e a verificação (uma por ficha, amarrada ao hash da ficha). Função pura: sem banco, sem relógio, testável.

export type EstadoDaFicha = "rascunho" | "em-conferencia" | "pronta" | "verificada" | "alterada";

export type EntradaDoEstado = {
  /** Itens com página cuja conferência bate o hash ATUAL do item (item mudado volta a "a conferir"). */
  conferidos: number;
  /** Itens com página: os que precisam de conferência. */
  total: number;
  /** A verificação gravada (o hash que valeu na hora), ou `null` se a ficha nunca foi verificada. */
  verificacao: { hash: string } | null;
  /** O hash ATUAL da ficha, calculado pelo banco. */
  hash: string;
};

/**
 * - verificada: há verificação e o hash dela é o atual;
 * - alterada: há verificação, mas de um hash antigo (o conteúdo mudou depois). Fica "alterada" até verificar de novo,
 *   mesmo que as páginas já estejam conferidas: uma mudança só na tese não mexe em nenhuma conferência de item, e a
 *   fila precisa continuar dizendo "volta a conferir";
 * - sem verificação: nenhuma página conferida é rascunho, algumas é em conferência, todas é pronta. Uma ficha sem
 *   nenhum item com página não tem o que conferir e o banco a deixa verificar, então é pronta.
 */
export function estadoDaFicha(e: EntradaDoEstado): EstadoDaFicha {
  if (e.verificacao) return e.verificacao.hash === e.hash ? "verificada" : "alterada";
  const total = Math.max(0, e.total);
  const conferidos = Math.min(Math.max(0, e.conferidos), total);
  if (conferidos >= total) return "pronta";
  return conferidos === 0 ? "rascunho" : "em-conferencia";
}

/** Ordem da fila: as prontas primeiro (é onde o dono age), depois o que está em andamento, e as verificadas por último. */
export const ORDEM_DA_FILA: readonly EstadoDaFicha[] = [
  "pronta",
  "em-conferencia",
  "rascunho",
  "alterada",
  "verificada",
];

export function posicaoNaFila(estado: EstadoDaFicha): number {
  return ORDEM_DA_FILA.indexOf(estado);
}

/** Quantas páginas ainda faltam conferir. Nunca negativo. */
export function faltam(conferidos: number, total: number): number {
  return Math.max(0, total - Math.min(Math.max(0, conferidos), total));
}

/** "Faltam 5 páginas a conferir." / "Falta 1 página a conferir." (contrato de copy). */
export function motivoDasPaginasFaltantes(n: number): string {
  return n === 1 ? "Falta 1 página a conferir." : `Faltam ${n} páginas a conferir.`;
}

/** "7 de 12 páginas conferidas" (o texto leva a informação; a barra é só reforço). */
export function textoDoProgresso(conferidos: number, total: number): string {
  const c = Math.min(Math.max(0, conferidos), Math.max(0, total));
  const t = Math.max(0, total);
  return `${c} de ${t} ${t === 1 ? "página conferida" : "páginas conferidas"}`;
}
