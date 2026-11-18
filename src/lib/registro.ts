// Único caminho de registro de falhas em código que toca `privado.*`.
// Grava só o contexto (texto fixo escrito pelo chamador), o código e o nome da classe do erro.
// Nunca grava o texto do erro, detalhes do banco, parâmetros de consulta, corpo de requisição
// nem o objeto de erro inteiro: um erro do driver ou do Drizzle pode carregar a Anotação.

const CODIGO_SEGURO = /^[A-Za-z0-9_]{1,32}$/;

function codigoDe(erro: unknown): string {
  for (const candidato of [erro, (erro as { cause?: unknown } | null)?.cause]) {
    const codigo = (candidato as { code?: unknown } | null)?.code;
    if (typeof codigo === "string" && CODIGO_SEGURO.test(codigo)) return codigo;
  }
  return "desconhecido";
}

function nomeDe(erro: unknown): string {
  const nome = erro instanceof Error ? erro.constructor.name : typeof erro;
  return CODIGO_SEGURO.test(nome) ? nome : "Erro";
}

export function registrarErro(contexto: string, erro: unknown): void {
  console.error(JSON.stringify({ contexto, codigo: codigoDe(erro), nome: nomeDe(erro) }));
}
