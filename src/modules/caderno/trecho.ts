import { MARCA_FIM, MARCA_INICIO } from "./marcas";

// Divide o trecho que o banco devolveu (com os marcadores de destaque) em pedaços de TEXTO, cada um dizendo
// se é uma palavra achada. O componente põe `<mark>` só nos achados: texto da pessoa nunca vira HTML.

export type Parte = { texto: string; achado: boolean };

export function dividirTrecho(trecho: string): Parte[] {
  const partes: Parte[] = [];
  let resto = trecho;
  while (resto.length > 0) {
    const abre = resto.indexOf(MARCA_INICIO);
    if (abre === -1) {
      partes.push({ texto: resto, achado: false });
      break;
    }
    if (abre > 0) partes.push({ texto: resto.slice(0, abre), achado: false });
    const depois = resto.slice(abre + MARCA_INICIO.length);
    const fecha = depois.indexOf(MARCA_FIM);
    if (fecha === -1) {
      // Marcador sem par (não deveria acontecer): o resto vai como texto comum.
      partes.push({ texto: depois, achado: false });
      break;
    }
    if (fecha > 0) partes.push({ texto: depois.slice(0, fecha), achado: true });
    resto = depois.slice(fecha + MARCA_FIM.length);
  }
  return partes.filter((p) => p.texto !== "");
}
