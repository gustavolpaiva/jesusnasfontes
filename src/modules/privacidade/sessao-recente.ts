// Sessão "recente": criada há no máximo 15 minutos. Para apagar a conta, sessão mais antiga exige um
// código de 6 dígitos enviado ao e-mail da própria conta (reautenticação).
export const SESSAO_RECENTE_MS = 15 * 60 * 1000;

export function sessaoRecente(criadaEm: Date, agora: Date = new Date()): boolean {
  return agora.getTime() - criadaEm.getTime() <= SESSAO_RECENTE_MS;
}

/** "19 de novembro de 2026", no fuso do Brasil. */
export function dataLonga(data: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "long",
    timeZone: "America/Sao_Paulo",
  }).format(data);
}
