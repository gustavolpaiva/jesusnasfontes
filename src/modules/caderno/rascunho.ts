import { estaVazio, semNulo } from "./limite";

// Rascunho local da Anotação (ANOT-02): o texto que ainda não chegou ao servidor fica NESTE aparelho,
// por Estudante e por Estudo, para sobreviver a uma queda de conexão e a recarregar a página. Só código de
// navegador. O aviso de privacidade promete que o rascunho "é apagado quando você sai": por isso as chaves
// levam o id do Estudante (nunca vale para outra conta), e `apagarTodosRascunhos` roda ao sair e ao apagar a
// conta, `apagarRascunhosDeOutros` ao abrir um Estudo.
//
// DUAS REGRAS, e só elas (cada regra de "quem apaga qual chave" que se acrescentava abria outro caso):
//  1. Cada MONTAGEM do editor escreve SÓ na sua chave, que leva um id nascido em memória naquela montagem (nada
//     de `sessionStorage` nem de id por carga de página: recarregar, duplicar a aba ou navegar para outro
//     Estudo e voltar dá um id novo, então nem duas abas nem o editor de antes e o de agora dividem uma chave,
//     e o rascunho de uma montagem anterior passa a ser, para a nova, um rascunho como os outros).
//  2. Apagar é SEMPRE comparar: `apagarRascunhosIguais` relê cada chave do armazenamento no instante de apagar
//     e só remove a que tem o MESMO texto que se acabou de confirmar no servidor (ou de descartar de propósito).
//     Texto igual ao que está guardado no servidor não tem o que perder; texto diferente, de qualquer aba,
//     nunca sai por posse, por adoção nem por ser "o rascunho desta aba".
//
// O texto é privado: a chave nunca o contém e nada aqui o manda a lugar algum além do `localStorage`. Acesso
// negado ao armazenamento (navegação privativa, cota) nunca derruba a tela: o rascunho só deixa de existir.

const PREFIXO = "jnf:rascunho:";

export type Rascunho = {
  corpo: string;
  /** A versão e o id da Anotação do servidor sobre a qual este texto foi escrito. 0 e nulo: nenhuma. */
  versaoBase: number;
  baseId: string | null;
  /** Instante (ms) da última mudança do texto, para mostrar a data no conflito. */
  salvoEm: number;
  /**
   * Escrito com um envio ainda sem resposta: o texto que estava a caminho e o instante do envio. O texto pode
   * ter chegado ao servidor, então um rascunho assim, mesmo igual à base que a página tinha, NÃO é "igual ao
   * servidor": só uma releitura que MOSTRE o efeito do envio (ou o prazo, `ENVIO_PERDIDO_MS`) o reconcilia.
   */
  aCaminho?: { texto: string; em: number };
};

const base = (estudanteId: string, estudoId: string) => `${PREFIXO}${estudanteId}:${estudoId}:`;

function armazem(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** `dono`: o id desta montagem do editor (uma chave por montagem). */
export function guardarRascunho(
  estudanteId: string,
  estudoId: string,
  dono: string,
  rascunho: Rascunho,
): void {
  try {
    armazem()?.setItem(`${base(estudanteId, estudoId)}${dono}`, JSON.stringify(rascunho));
  } catch {
    // Cota cheia ou acesso negado: o texto segue na tela e no servidor; só o rascunho local falha.
  }
}

function lerChave(nomeDaChave: string): Rascunho | null {
  try {
    const bruto = armazem()?.getItem(nomeDaChave);
    if (!bruto) return null;
    const lido: unknown = JSON.parse(bruto);
    if (typeof lido !== "object" || lido === null) return null;
    const { corpo, versaoBase, baseId, salvoEm } = lido as Record<string, unknown>;
    if (typeof corpo !== "string") return null;
    if (typeof versaoBase !== "number" || !Number.isInteger(versaoBase) || versaoBase < 0) {
      return null;
    }
    if (baseId !== null && typeof baseId !== "string") return null;
    if (typeof salvoEm !== "number" || !Number.isFinite(salvoEm)) return null;
    const { aCaminho } = lido as Record<string, unknown>;
    const a = aCaminho as { texto?: unknown; em?: unknown } | null | undefined;
    const valido = a && typeof a.texto === "string" && typeof a.em === "number";
    return {
      corpo,
      versaoBase,
      baseId,
      salvoEm,
      ...(valido ? { aCaminho: { texto: a.texto as string, em: a.em as number } } : {}),
    };
  } catch {
    return null;
  }
}

function chavesDeRascunho(): string[] {
  const guardado = armazem();
  if (!guardado) return [];
  const chaves: string[] = [];
  for (let i = 0; i < guardado.length; i++) {
    const c = guardado.key(i);
    if (c?.startsWith(PREFIXO)) chaves.push(c);
  }
  return chaves;
}

/** Todos os rascunhos deste Estudante neste Estudo (de qualquer aba, o desta carga também), o mais recente primeiro. */
export function lerRascunhos(estudanteId: string, estudoId: string): Rascunho[] {
  const achados: Rascunho[] = [];
  for (const c of chavesDeRascunho()) {
    if (!c.startsWith(base(estudanteId, estudoId))) continue;
    const r = lerChave(c);
    if (r) achados.push(r);
  }
  return achados.sort((a, b) => b.salvoEm - a.salvoEm);
}

const mesmoTexto = (a: string, b: string) =>
  semNulo(a) === semNulo(b) || (estaVazio(a) && estaVazio(b));

/**
 * Apaga o rascunho DESTA montagem do editor (só o dele). Ele espelha o campo: quando o campo volta a ser igual
 * ao servidor (inclusive vazio, sem Anotação), o que ele guardou de antes já não vale e sai na hora.
 */
export function apagarRascunhoDestaMontagem(
  estudanteId: string,
  estudoId: string,
  dono: string,
): void {
  try {
    armazem()?.removeItem(`${base(estudanteId, estudoId)}${dono}`);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/**
 * Apaga os rascunhos deste Estudo cujo texto, LIDO DO ARMAZENAMENTO AGORA, é igual a `corpo` (o que o servidor
 * acabou de confirmar, ou o que a pessoa acabou de descartar). Os de texto diferente ficam, seja de que aba for.
 */
export function apagarRascunhosIguais(
  estudanteId: string,
  estudoId: string,
  corpo: string,
  { confirmado = true }: { confirmado?: boolean } = {},
): void {
  try {
    for (const c of chavesDeRascunho()) {
      if (!c.startsWith(base(estudanteId, estudoId))) continue;
      const agora = lerChave(c);
      // `confirmado: false` (a base que a página tinha, ainda não relida): os escritos com envio a caminho ficam.
      if (agora && (confirmado || !agora.aCaminho) && mesmoTexto(agora.corpo, corpo)) {
        armazem()?.removeItem(c);
      }
    }
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/** Rascunhos de OUTRA conta no mesmo aparelho (um aparelho compartilhado): saem ao abrir um Estudo. */
export function apagarRascunhosDeOutros(estudanteId: string): void {
  try {
    for (const c of chavesDeRascunho()) {
      if (!c.startsWith(`${PREFIXO}${estudanteId}:`)) armazem()?.removeItem(c);
    }
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/** Todo rascunho deste aparelho: ao sair da conta e ao apagar a conta. */
export function apagarTodosRascunhos(): void {
  try {
    for (const c of chavesDeRascunho()) armazem()?.removeItem(c);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}
