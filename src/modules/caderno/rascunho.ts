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

// O rascunho é DA ABA: duas abas do mesmo navegador no mesmo Estudo dividem o `localStorage`, e com uma chave só
// a confirmação de um envio numa aba apagava (e cada tecla sobrescrevia) o texto ainda pendente da outra. A
// chave leva o id da aba, guardado no `sessionStorage` (sobrevive a recarregar a aba, não a fechá-la).
const CHAVE_DA_ABA = "jnf:aba";
let abaEmMemoria: string | null = null;

function idDaAba(): string {
  if (abaEmMemoria) return abaEmMemoria;
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(CHAVE_DA_ABA);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(CHAVE_DA_ABA, id);
    }
  } catch {
    id = id ?? crypto.randomUUID();
  }
  abaEmMemoria = id;
  return id;
}

const base = (estudanteId: string, estudoId: string) => `${PREFIXO}${estudanteId}:${estudoId}:`;
const chave = (estudanteId: string, estudoId: string) =>
  `${base(estudanteId, estudoId)}${idDaAba()}`;

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
  return lerChave(chave(estudanteId, estudoId));
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
    return { corpo, versaoBase, baseId, salvoEm };
  } catch {
    return null;
  }
}

/**
 * Rascunhos deste Estudante neste Estudo guardados por OUTRAS abas (uma aba fechada, ou ainda aberta), o mais
 * recente primeiro. Nunca incluem o desta aba.
 */
export function lerRascunhosDeOutrasAbas(
  estudanteId: string,
  estudoId: string,
): { chave: string; rascunho: Rascunho }[] {
  const minha = chave(estudanteId, estudoId);
  const achados: { chave: string; rascunho: Rascunho }[] = [];
  for (const c of chavesDeRascunho()) {
    if (!c.startsWith(base(estudanteId, estudoId)) || c === minha) continue;
    const rascunho = lerChave(c);
    if (rascunho) achados.push({ chave: c, rascunho });
  }
  return achados.sort((a, b) => b.rascunho.salvoEm - a.rascunho.salvoEm);
}

/** Apaga um rascunho pelo nome da chave (o de outra aba que esta aba adotou e já resolveu). */
export function apagarRascunhoPorChave(nomeDaChave: string): void {
  try {
    armazem()?.removeItem(nomeDaChave);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/** Apaga SÓ o rascunho desta aba. */
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
