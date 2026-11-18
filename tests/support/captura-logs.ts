import { readFileSync } from "node:fs";

// Apoio aos testes que provam que um texto não aparece na saída do servidor.
// JNF_LOG_SERVIDOR é o caminho do log que o executor de e2e manda o servidor gravar.

export function lerLogServidor(): string {
  const caminho = process.env.JNF_LOG_SERVIDOR;
  if (!caminho) throw new Error("JNF_LOG_SERVIDOR não definido: rode pelo executor de e2e");
  return readFileSync(caminho, "utf8");
}

export function procurarNoLog(texto: string): boolean {
  return lerLogServidor().includes(texto);
}
