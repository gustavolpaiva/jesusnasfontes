// Rascunho local da Anotação (ANOT-02): o texto que ainda não chegou ao servidor fica NESTE aparelho,
// por Estudante e por Estudo, para sobreviver a uma queda de conexão e a recarregar a página. Só código de
// navegador. O aviso de privacidade promete que o rascunho "é apagado quando você sai": por isso as chaves
// levam o id do Estudante (nunca vale para outra conta), e `apagarTodosRascunhos` roda ao sair e ao apagar a
// conta, `apagarRascunhosDeOutros` ao abrir um Estudo.
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
};

const chave = (estudanteId: string, estudoId: string) => `${PREFIXO}${estudanteId}:${estudoId}`;

function armazem(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function guardarRascunho(estudanteId: string, estudoId: string, rascunho: Rascunho): void {
  try {
    armazem()?.setItem(chave(estudanteId, estudoId), JSON.stringify(rascunho));
  } catch {
    // Cota cheia ou acesso negado: o texto segue na tela e no servidor; só o rascunho local falha.
  }
}

export function lerRascunho(estudanteId: string, estudoId: string): Rascunho | null {
  try {
    const bruto = armazem()?.getItem(chave(estudanteId, estudoId));
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
    return { corpo, versaoBase, baseId, salvoEm };
  } catch {
    return null;
  }
}

export function apagarRascunho(estudanteId: string, estudoId: string): void {
  try {
    armazem()?.removeItem(chave(estudanteId, estudoId));
  } catch {
    // Sem armazenamento, não há o que apagar.
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
