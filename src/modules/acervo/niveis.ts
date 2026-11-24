import { NIVEIS, type Nivel } from "./schemas";

// Lista fechada dos Níveis de fonte (ACER-01, D-13). O valor de `?nivel=` é texto da URL: só vira Nível se
// for exatamente um dos três valores; qualquer outra coisa é "sem filtro". O valor da URL nunca é usado em
// consulta: a lista filtra em memória, sobre o que o banco já devolveu.

/** A ordem fixa de exibição: do mais direto ao mais interpretado. */
export const NIVEIS_NA_ORDEM: readonly Nivel[] = NIVEIS;

export const NOME_DO_NIVEL: Record<Nivel, string> = {
  primaria: "Fonte primária",
  academica: "Pesquisa acadêmica",
  confessional: "Leitura confessional",
};

/** Frase do glossário de cada Nível (contrato de copy da lista). */
export const FRASE_DO_NIVEL: Record<Nivel, string> = {
  primaria: "Texto antigo, testemunho direto ou próximo do período.",
  academica:
    "Obra de estudioso que analisa as Fontes primárias com método histórico. Aparece como ficha.",
  confessional: "Interpretação de uma tradição cristã, sempre com a tradição nomeada.",
};

/** O Nível do parâmetro, ou `null` quando o valor não é exatamente um dos três (ou nem é texto). */
export function lerNivelDoParametro(valor: unknown): Nivel | null {
  if (typeof valor !== "string") return null;
  return NIVEIS_NA_ORDEM.find((n) => n === valor) ?? null;
}

/** "1 Fonte primária", "39 Fontes primárias", "1 ficha", "Nenhuma Fonte"; sem Nível, o total de Fontes. */
export function contagemEmTexto(nivel: Nivel | null, n: number): string {
  if (n === 0) return "Nenhuma Fonte";
  const um = n === 1;
  if (nivel === null) return um ? "1 Fonte" : `${n} Fontes`;
  if (nivel === "primaria") return um ? "1 Fonte primária" : `${n} Fontes primárias`;
  if (nivel === "academica") return um ? "1 ficha" : `${n} fichas`;
  return um ? "1 Fonte de leitura confessional" : `${n} Fontes de leitura confessional`;
}
