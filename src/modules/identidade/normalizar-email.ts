import { z } from "zod";

// Forma única do endereço para guardar e comparar: sem espaços nas pontas, NFKC, minúsculas.
export function normalizarEmail(texto: string): string {
  return texto.trim().normalize("NFKC").toLowerCase();
}

const formato = z.email().max(254);

// Devolve o endereço normalizado, ou null se o formato não presta.
export function lerEmail(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  const normalizado = normalizarEmail(texto);
  return formato.safeParse(normalizado).success ? normalizado : null;
}
