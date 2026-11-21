// Rascunho local da Anotação (ANOT-02): o texto que o servidor ainda não confirmou fica NESTE aparelho, por
// Estudante e por Estudo, para sobreviver a uma queda de conexão e a recarregar a página. Só código de
// navegador. O aviso de privacidade promete que o rascunho "é apagado quando você sai": por isso as chaves
// levam o id do Estudante (nunca vale para outra conta), e `apagarTodosRascunhos` roda ao sair e ao apagar a
// conta, `apagarRascunhosDeOutros` ao abrir um Estudo.
//
// UMA REGRA: cada chave tem UM dono, o escritor (a montagem do editor) cujo id está nela, e só quem segura a
// trava desse escritor (`segurarEscritor`, uma Web Lock do navegador, comum a todas as abas) lê para retomar,
// escreve ou apaga a chave. O escritor vivo segura a sua trava do começo ao fim; quando ele some (a aba fechou,
// recarregou, ou o editor saiu da tela), a trava se solta e o PRÓXIMO editor deste Estudo pode retomá-lo
// inteiro: o mesmo id, o número do último envio, a base e o texto. Ninguém apaga a chave de outro por
// comparação de texto, por posse presumida ou por adoção de uma aba ainda aberta.
//
// O rascunho existe enquanto o escritor tem algo que o servidor não confirmou; confirmado, o dono o apaga.
//
// SAIR (e apagar a conta) vale para TODAS as abas: `apagarTodosRascunhos` troca primeiro a MARCA DA SAÍDA e só
// depois apaga as chaves. Todo editor guarda a marca que viu ao abrir e, antes e depois de cada escrita, a
// confere; mudou, ele se encerra: apaga a própria chave e nunca mais grava nem envia (e a ouve pelo evento
// `storage`, para parar na hora). Uma escrita que corra junto da limpeza é desfeita pela conferência de depois.
//
// O texto é privado: a chave nunca o contém e nada aqui o manda a lugar algum além do `localStorage`. Acesso
// negado ao armazenamento (navegação privativa, cota) nunca derruba a tela: o rascunho só deixa de existir.

const PREFIXO = "jnf:rascunho:";
/** Fora do prefixo dos rascunhos de propósito: a limpeza não a apaga, troca. */
export const CHAVE_DA_SAIDA = "jnf:saida";

/** A marca da última saída (ou apagamento da conta) neste aparelho; `null` se nunca houve. */
export function marcaDaSaida(): string | null {
  try {
    return armazem()?.getItem(CHAVE_DA_SAIDA) ?? null;
  } catch {
    return null;
  }
}

export type Rascunho = {
  /** O id do escritor dono desta chave. */
  montagem: string;
  /** O número do último envio que esse escritor fez (0: nenhum). O próximo envio usa o seguinte. */
  seq: number;
  corpo: string;
  /** A versão e o id da Anotação do servidor que o escritor tinha confirmado. 0 e nulo: nenhuma. */
  versaoBase: number;
  baseId: string | null;
  /** Instante (ms) da última mudança do texto: a ordem entre rascunhos e a data mostrada no conflito. */
  salvoEm: number;
};

const prefixoDoEstudo = (estudanteId: string, estudoId: string) =>
  `${PREFIXO}${estudanteId}:${estudoId}:`;

function armazem(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function guardarRascunho(estudanteId: string, estudoId: string, rascunho: Rascunho): void {
  try {
    armazem()?.setItem(
      `${prefixoDoEstudo(estudanteId, estudoId)}${rascunho.montagem}`,
      JSON.stringify(rascunho),
    );
  } catch {
    // Cota cheia ou acesso negado: o texto segue na tela; só o rascunho local falha.
  }
}

const inteiroNaoNegativo = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

function lerChave(nomeDaChave: string, montagem: string): Rascunho | null {
  try {
    const bruto = armazem()?.getItem(nomeDaChave);
    if (!bruto) return null;
    const lido: unknown = JSON.parse(bruto);
    if (typeof lido !== "object" || lido === null) return null;
    const r = lido as Record<string, unknown>;
    // O dono escrito dentro tem de ser o da chave: uma chave copiada para outro nome não vale.
    if (r.montagem !== montagem || typeof r.corpo !== "string") return null;
    if (!inteiroNaoNegativo(r.seq) || !inteiroNaoNegativo(r.versaoBase)) return null;
    if (r.baseId !== null && typeof r.baseId !== "string") return null;
    if (typeof r.salvoEm !== "number" || !Number.isFinite(r.salvoEm)) return null;
    return {
      montagem,
      seq: r.seq,
      corpo: r.corpo,
      versaoBase: r.versaoBase,
      baseId: r.baseId,
      salvoEm: r.salvoEm,
    };
  } catch {
    return null;
  }
}

function chavesDeRascunho(prefixo = PREFIXO): string[] {
  const guardado = armazem();
  if (!guardado) return [];
  const chaves: string[] = [];
  for (let i = 0; i < guardado.length; i++) {
    const c = guardado.key(i);
    if (c?.startsWith(prefixo)) chaves.push(c);
  }
  return chaves;
}

/** Os rascunhos deste Estudante neste Estudo (de qualquer escritor), o mais recente primeiro. */
export function lerRascunhos(estudanteId: string, estudoId: string): Rascunho[] {
  const prefixo = prefixoDoEstudo(estudanteId, estudoId);
  const achados: Rascunho[] = [];
  for (const c of chavesDeRascunho(prefixo)) {
    const r = lerChave(c, c.slice(prefixo.length));
    if (r) achados.push(r);
  }
  return achados.sort((a, b) => b.salvoEm - a.salvoEm);
}

/** O rascunho de UM escritor, lido agora (para retomá-lo depois de segurar a trava dele). */
export function lerRascunho(
  estudanteId: string,
  estudoId: string,
  montagem: string,
): Rascunho | null {
  return lerChave(`${prefixoDoEstudo(estudanteId, estudoId)}${montagem}`, montagem);
}

/** Só o dono (quem segura a trava do escritor) apaga a chave dele. */
export function apagarRascunho(estudanteId: string, estudoId: string, montagem: string): void {
  try {
    armazem()?.removeItem(`${prefixoDoEstudo(estudanteId, estudoId)}${montagem}`);
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

/** Todo rascunho deste aparelho: ao sair da conta e ao apagar a conta. A marca da saída muda ANTES. */
export function apagarTodosRascunhos(): void {
  try {
    armazem()?.setItem(CHAVE_DA_SAIDA, crypto.randomUUID());
    for (const c of chavesDeRascunho()) armazem()?.removeItem(c);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/**
 * Tenta segurar a trava do escritor `montagem` (uma Web Lock, vista por todas as abas desta origem). Devolve
 * a função que a solta, ou `null` se outro editor vivo a segura agora. Pedido sem espera (`ifAvailable`): ou
 * se pega na hora, ou não. Sem a API (navegador antigo, contexto sem HTTPS), cada aba age como a única e a
 * trava é dada como segura: é a degradação declarada.
 */
export function segurarEscritor(montagem: string): Promise<(() => void) | null> {
  const travas = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!travas) return Promise.resolve(() => {});
  return new Promise((resolver) => {
    travas
      .request(`jnf:escritor:${montagem}`, { ifAvailable: true }, (trava) => {
        if (!trava) {
          resolver(null);
          return;
        }
        // A trava fica segura enquanto esta promessa não termina.
        return new Promise<void>((soltar) => resolver(() => soltar()));
      })
      .catch(() => resolver(() => {}));
  });
}
