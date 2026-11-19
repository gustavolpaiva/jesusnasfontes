import pg from "pg";

// Erro nosso para falhas da camada de banco. O erro original do driver e o do Drizzle carregam o
// texto da consulta, os PARÂMETROS dela (token de sessão, código e link de entrada, e-mail, texto
// privado) e, no driver, detalhes com valores. Qualquer coisa que imprima o erro inteiro (um
// `throw` não tratado que o Next mostra, o logger de uma biblioteca) vazaria isso. Por isso, o que
// sai da camada de banco é só: o código (SQLSTATE) e o nome da restrição, que não são sensíveis.
// Sem `message` original, sem `cause`, sem consulta e sem parâmetros.

const CODIGO_SEGURO = /^[A-Za-z0-9_]{1,32}$/;
const NOME_SEGURO = /^[A-Za-z0-9_$.]{1,128}$/;

export class ErroDeBanco extends Error {
  readonly code: string;
  readonly constraint?: string;
  constructor(code: string, constraint?: string) {
    super("falha na camada de banco");
    this.name = "ErroDeBanco";
    this.code = code;
    if (constraint !== undefined) this.constraint = constraint;
  }
}

function campoSeguro(erro: unknown, campo: string, formato: RegExp): string | undefined {
  const valor = (erro as Record<string, unknown> | null)?.[campo];
  return typeof valor === "string" && formato.test(valor) ? valor : undefined;
}

// Erro que veio do banco, do driver ou do Drizzle (e não do nosso código).
function veioDoBanco(erro: unknown): boolean {
  if (erro instanceof ErroDeBanco) return false;
  if (erro instanceof pg.DatabaseError) return true;
  const e = erro as { query?: unknown; params?: unknown; severity?: unknown; syscall?: unknown };
  if (e === null || typeof e !== "object") return false;
  return "query" in e || "params" in e || typeof e.severity === "string" || "syscall" in e;
}

// Devolve o erro de banco sanitizado; qualquer outro erro passa intacto.
export function sanitizarErroDeBanco(erro: unknown): unknown {
  if (!veioDoBanco(erro)) return erro;
  let codigo: string | undefined;
  let restricao: string | undefined;
  let atual: unknown = erro;
  for (let i = 0; i < 5 && atual && typeof atual === "object"; i++) {
    codigo ??= campoSeguro(atual, "code", CODIGO_SEGURO);
    restricao ??= campoSeguro(atual, "constraint", NOME_SEGURO);
    atual = (atual as { cause?: unknown }).cause;
  }
  return new ErroDeBanco(codigo ?? "desconhecido", restricao);
}
