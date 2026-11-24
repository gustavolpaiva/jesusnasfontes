import type { ItemDeNavegacao } from "./navegacao";

// A faixa de navegação tem quatro itens para todos: com cinco, a palavra "Caderno" em versalete não cabe
// na coluna de 320 px sem quebrar no meio. Os destinos de administração vão para o Menu.
export const ITENS_DA_FAIXA: readonly ItemDeNavegacao[] = [
  { href: "/trilhas", rotulo: "Trilhas" },
  { href: "/acervo", rotulo: "Acervo" },
  { href: "/caderno", rotulo: "Caderno" },
  { href: "/conta", rotulo: "Conta" },
];

// No cabeçalho (a partir de 1024 px) o Admin ganha um link para a entrada da Administração.
export const ENTRADA_DA_ADMINISTRACAO: ItemDeNavegacao = {
  href: "/admin",
  rotulo: "Administração",
};
