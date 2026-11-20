// Escolha da voz em português entre as que o aparelho oferece (AUD-02, AUD-03). A API de fala do
// navegador fica atrás destas formas mínimas: o código do produto nunca fala com `speechSynthesis`
// por outro caminho, e os testes trocam o motor por um falso. Nenhuma detecção por user agent: só a
// presença da API e das vozes decide.

export interface VozLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
}

export interface FalaLike {
  text: string;
  lang: string;
  voice: VozLike | null;
  onstart: ((evento: unknown) => void) | null;
  onend: ((evento: unknown) => void) | null;
  onerror: ((evento: { error?: string }) => void) | null;
}

export interface SinteseLike {
  speak(fala: FalaLike): void;
  cancel(): void;
  getVoices(): VozLike[];
  addEventListener?(tipo: "voiceschanged", ouvinte: () => void): void;
  removeEventListener?(tipo: "voiceschanged", ouvinte: () => void): void;
}

export type EscolhaDeVoz =
  | { tipo: "voz"; voz: VozLike; portugal: boolean }
  | { tipo: "sem-voz" }
  | { tipo: "sem-suporte" };

export type ArmazenamentoLike = Pick<Storage, "getItem" | "setItem">;

export type OpcoesDaEscolha = {
  /** Quanto esperar pelas vozes (evento `voiceschanged`). Padrão: 2 s. */
  esperaMs?: number;
  /** Onde lembrar a escolha. Padrão: `localStorage`, quando existe. */
  armazenamento?: ArmazenamentoLike | null;
  /** Chamado quando a escolha vai esperar: é o momento de mostrar "Procurando voz em português…". */
  aoEsperar?: () => void;
};

export const ESPERA_PELAS_VOZES_MS = 2000;
export const CHAVE_DA_VOZ = "jnf-voz";

type Regiao = "brasil" | "portugal" | "outra";

/** `pt_BR`, `PT-br`, `pt-BR` e `por-BRA` chegam à mesma forma: minúsculas, hífen. */
export function normalizarLingua(lang: string): string {
  return lang.trim().replace(/_/g, "-").toLowerCase();
}

function regiaoDe(lang: string): Regiao | null {
  const l = normalizarLingua(lang);
  const m = /^(pt|por)(?:-([a-z]{2,3}))?(?:-|$)/.exec(l);
  if (!m) return null;
  const regiao = m[2];
  if (regiao === "br" || regiao === "bra") return "brasil";
  if (regiao === "pt" || regiao === "prt") return "portugal";
  return "outra";
}

/** Voz em português de qualquer região. */
export function ehPortugues(voz: VozLike): boolean {
  return regiaoDe(voz.lang) !== null;
}

function nota(voz: VozLike): number {
  const regiao = regiaoDe(voz.lang);
  const base = regiao === "brasil" ? 0 : regiao === "outra" ? 1 : 2;
  // Voz do próprio aparelho antes da de rede: o texto não sai do aparelho (T-01-51).
  return base * 2 + (voz.localService ? 0 : 1);
}

function lerVozes(sintese: SinteseLike): VozLike[] {
  try {
    return Array.from(sintese.getVoices() ?? []);
  } catch {
    return [];
  }
}

function esperarVozes(sintese: SinteseLike, esperaMs: number): Promise<VozLike[]> {
  return new Promise((resolver) => {
    let pronto = false;
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const terminar = () => {
      if (pronto) return;
      pronto = true;
      if (relogio !== undefined) clearTimeout(relogio);
      sintese.removeEventListener?.("voiceschanged", aoMudar);
      resolver(lerVozes(sintese));
    };
    const aoMudar = () => {
      if (lerVozes(sintese).some(ehPortugues)) terminar();
    };
    sintese.addEventListener?.("voiceschanged", aoMudar);
    relogio = setTimeout(terminar, esperaMs);
  });
}

function armazenamentoPadrao(): ArmazenamentoLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Navegador que recusa o acesso (modo privado, cookies bloqueados): segue sem lembrar.
    return null;
  }
}

/**
 * Escolhe a voz: espera as vozes por até 2 s, prefere pt-BR, depois outras regiões, e português de
 * Portugal só quando é o que há (`portugal: true` leva o aviso do sotaque). Dentro da mesma região,
 * prefere a voz do aparelho à de rede. Lembra a escolha em `localStorage`; o valor lembrado só vale se
 * ainda for uma voz em português existente.
 */
export async function escolherVoz(
  sintese: SinteseLike | null | undefined,
  opcoes: OpcoesDaEscolha = {},
): Promise<EscolhaDeVoz> {
  if (!sintese || typeof sintese.speak !== "function" || typeof sintese.getVoices !== "function") {
    return { tipo: "sem-suporte" };
  }
  let vozes = lerVozes(sintese);
  if (!vozes.some(ehPortugues)) {
    opcoes.aoEsperar?.();
    vozes = await esperarVozes(sintese, opcoes.esperaMs ?? ESPERA_PELAS_VOZES_MS);
  }
  const portuguesas = vozes.filter(ehPortugues);
  if (portuguesas.length === 0) return { tipo: "sem-voz" };

  const armazenamento =
    opcoes.armazenamento === undefined ? armazenamentoPadrao() : opcoes.armazenamento;
  let lembrada: string | null = null;
  try {
    lembrada = armazenamento?.getItem(CHAVE_DA_VOZ) ?? null;
  } catch {
    lembrada = null;
  }
  const escolhida =
    portuguesas.find((v) => lembrada !== null && v.voiceURI === lembrada) ??
    [...portuguesas].sort((a, b) => nota(a) - nota(b))[0];
  if (!escolhida) return { tipo: "sem-voz" };
  try {
    armazenamento?.setItem(CHAVE_DA_VOZ, escolhida.voiceURI);
  } catch {
    // Sem lembrar: a próxima visita escolhe de novo.
  }
  return { tipo: "voz", voz: escolhida, portugal: regiaoDe(escolhida.lang) === "portugal" };
}
