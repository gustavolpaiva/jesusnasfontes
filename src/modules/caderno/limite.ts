// Limite da Anotação (decisão do contrato, P07): 20 000 caracteres, contados como o campo conta (unidades
// de UTF-16). Arquivo sem banco e sem servidor: o navegador usa a constante para a contagem e o servidor
// valida de novo, nunca confiando no que o navegador diz. O limite NÃO é uma restrição do banco, de
// propósito: o banco repete a linha inteira na mensagem de uma violação, e a linha carrega o texto privado.

export const ANOTACAO_MAX = 20_000;

/** O nulo de texto (NUL) o Postgres não guarda; sai antes de gravar, para não falhar por um caractere invisível. */
export const semNulo = (texto: string): string => texto.replaceAll("\u0000", "");

/** Texto vazio, ou só espaços, é a Anotação apagada. */
export const estaVazio = (texto: string): boolean => texto.trim() === "";

/** O termo da busca do Caderno: uma palavra, ou poucas. Maior que isto, o servidor recusa. */
export const TERMO_MAX = 100;
