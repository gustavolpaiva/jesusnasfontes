// Limites da busca do Acervo, sem banco e sem servidor: o navegador usa a constante para limitar o campo e o
// servidor valida de novo, nunca confiando no que o navegador diz.

/** O termo da busca: uma palavra, ou poucas. Maior que isto, o servidor recusa. */
export const TERMO_DA_BUSCA_MAX = 100;

/** Onde a tela da lista deixa o termo para a tela de busca (guardado na aba, nunca na URL; lido uma vez). */
export const CHAVE_DO_TERMO_PENDENTE = "acervo-busca-termo";
