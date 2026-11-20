// Divide um texto em trechos para a fala: cada trecho vira uma fala enfileirada no aparelho. Trechos
// curtos importam por dois motivos: o Chrome interrompe falas longas no meio, e pausar recomeça do
// trecho (ver `LeitorEmVoz`), então trecho pequeno é pouca coisa repetida ao continuar.

/** Tamanho máximo de um trecho, em caracteres. */
export const TAMANHO_MAXIMO_DO_TRECHO = 200;

// Reserva para um ambiente sem o segmentador de frases: corta depois de . ! ? …, com as aspas e os
// parênteses que fecham a frase.
const FRASES = /[^.!?…]+(?:[.!?…]+["”’»)]*\s*|$)/gu;

// O segmentador de frases do navegador (ausente em ambientes antigos, daí a reserva acima).
const Segmentador = Intl.Segmenter as typeof Intl.Segmenter | undefined;

function emFrases(paragrafo: string): string[] {
  if (Segmentador) {
    const segmentador = new Segmentador("pt", { granularity: "sentence" });
    return Array.from(segmentador.segment(paragrafo), (s) => s.segment);
  }
  return paragrafo.match(FRASES) ?? [paragrafo];
}

// Quebra uma frase longa em vírgulas, ponto e vírgula e dois-pontos, juntando as partes enquanto
// couberem; o que ainda passar do limite quebra no espaço mais próximo antes do limite.
function quebrarFraseLonga(frase: string, maximo: number): string[] {
  const partes = frase.split(/(?<=[,;:])\s+/u);
  const saida: string[] = [];
  let atual = "";
  const fechar = () => {
    if (atual !== "") saida.push(atual);
    atual = "";
  };
  for (const parte of partes) {
    if (parte.length > maximo) {
      fechar();
      saida.push(...quebrarNoEspaco(parte, maximo));
    } else if (atual === "") {
      atual = parte;
    } else if (atual.length + 1 + parte.length <= maximo) {
      atual = `${atual} ${parte}`;
    } else {
      fechar();
      atual = parte;
    }
  }
  fechar();
  return saida;
}

function quebrarNoEspaco(texto: string, maximo: number): string[] {
  const saida: string[] = [];
  let resto = texto;
  while (resto.length > maximo) {
    let corte = resto.lastIndexOf(" ", maximo);
    // Palavra maior que o limite (não acontece em português): corta onde der.
    if (corte <= 0) corte = maximo;
    saida.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto !== "") saida.push(resto);
  return saida;
}

/**
 * Divide o texto em trechos de até `maximo` caracteres (200 por padrão), uma frase por trecho quando
 * ela cabe. Linhas em branco separam parágrafos e nunca se juntam num trecho só. Não devolve trecho
 * vazio.
 */
export function dividirEmTrechos(texto: string, maximo = TAMANHO_MAXIMO_DO_TRECHO): string[] {
  const trechos: string[] = [];
  for (const paragrafo of texto.split(/\n+/u)) {
    const limpo = paragrafo.replace(/\s+/gu, " ").trim();
    if (limpo === "") continue;
    for (const bruta of emFrases(limpo)) {
      const frase = bruta.trim();
      if (frase === "") continue;
      if (frase.length <= maximo) trechos.push(frase);
      else trechos.push(...quebrarFraseLonga(frase, maximo));
    }
  }
  return trechos;
}
