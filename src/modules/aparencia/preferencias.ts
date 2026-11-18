// Preferências de aparência guardadas em cookie, por aparelho. O cookie vem do navegador, então
// só valores da lista entram; qualquer outro vira o padrão (T-01-20).

export const COOKIE_TEMA = "tema";
export const COOKIE_ESCALA = "escala-texto";

export type Tema = "claro" | "escuro";
export type Passo = 1 | 2 | 3 | 4 | 5;

export const ESCALAS = [0.9, 1, 1.15, 1.3, 1.5] as const;
export const NOMES_DOS_PASSOS = ["Menor", "Padrão", "Grande", "Maior", "Máximo"] as const;
export const PASSO_PADRAO: Passo = 2;

export type Preferencias = { tema: Tema | null; passo: Passo };

type ArmazemDeCookies = { get(nome: string): { value: string } | undefined };

export function ehPasso(valor: unknown): valor is Passo {
  return valor === 1 || valor === 2 || valor === 3 || valor === 4 || valor === 5;
}

export function lerPreferencias(cookies: ArmazemDeCookies): Preferencias {
  const tema = cookies.get(COOKIE_TEMA)?.value;
  const bruto = cookies.get(COOKIE_ESCALA)?.value;
  const passo = bruto !== undefined && /^[1-5]$/.test(bruto) ? Number(bruto) : PASSO_PADRAO;
  return {
    tema: tema === "claro" || tema === "escuro" ? tema : null,
    passo: ehPasso(passo) ? passo : PASSO_PADRAO,
  };
}

export function escalaDoPasso(passo: Passo): number {
  return ESCALAS[passo - 1] ?? 1;
}
