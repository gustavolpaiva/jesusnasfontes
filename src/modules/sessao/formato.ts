// Datas, horas e duração da Sessão. Tudo no fuso de São Paulo (o do grupo), não no do servidor: o servidor
// da Vercel roda em UTC e a hora "14:05" tem de ser a que a pessoa viveu. Sem banco e sem servidor: serve
// às telas do servidor e do navegador.

const FUSO = "America/Sao_Paulo";

const HORA = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: FUSO,
});
const DATA = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  timeZone: FUSO,
});
const DIA = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO });

export const formatarHora = (d: Date): string => HORA.format(d);
/** "12/11". */
export const formatarData = (d: Date): string => DATA.format(d);
export const mesmoDia = (a: Date, b: Date): boolean => DIA.format(a) === DIA.format(b);

/** Minutos inteiros entre dois instantes, arredondados; nunca negativo. */
export function minutosEntre(inicio: Date, fim: Date): number {
  return Math.max(0, Math.round((fim.getTime() - inicio.getTime()) / 60_000));
}

/** "17 min", com espaço sem quebra: o número nunca fica numa linha e "min" na outra. */
export const formatarDuracao = (minutos: number): string => `${minutos}\u00a0min`;
