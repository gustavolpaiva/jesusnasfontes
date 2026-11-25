// Passo ÚNICO (como uma migração) que acrescenta `revisao` a cada entrada de `data/acervo-derivados.lock.json` (plano
// 02-22, revisão cruzada: o build nunca leva uma Fonte para trás). NÃO regenera derivado nenhum: só lê o arquivo
// de cada um, confere o sha256 e os bytes contra o lock, acrescenta `revisao: 1` e confere de novo que os bytes de todo
// derivado continuam os mesmos depois. Recusa lock que já tem `revisao` em alguma entrada (rodar duas vezes não muda nada
// nem esconde engano) e sai sem escrever se qualquer conferência falhar.
//
//   pnpm exec tsx scripts/acervo/lock-adicionar-revisao.ts [--lock <arquivo>] [--derivados <pasta>]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CAMINHO_LOCK, ErroDerivado, PASTA_DERIVADOS } from "./derivados";

type EntradaAntiga = { sha256: string; bytes: number; revisao?: unknown };
type LockAntigo = {
  orcamento_arquivo_bytes: number;
  orcamento_total_bytes: number;
  derivados: Record<string, EntradaAntiga>;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Só acrescenta `revisao: 1`; todo o resto da entrada (sha256, bytes) e a ordem das chaves ficam como estão. */
export function adicionarRevisao(lock: LockAntigo): LockAntigo {
  const derivados: Record<string, EntradaAntiga> = {};
  for (const [slug, e] of Object.entries(lock.derivados)) {
    if ("revisao" in e) throw new ErroDerivado(`derivado ${slug}: o lock já tem revisao`);
    derivados[slug] = { sha256: e.sha256, bytes: e.bytes, revisao: 1 };
  }
  return { ...lock, derivados };
}

/** Os bytes de cada derivado no disco, conferidos contra o lock. Lança se algum não bate. */
function conferirBytes(pasta: string, lock: LockAntigo): Record<string, string> {
  const vistos: Record<string, string> = {};
  for (const [slug, e] of Object.entries(lock.derivados)) {
    const bytes = readFileSync(path.join(pasta, `${slug}.json`));
    const obtido = sha256(bytes);
    if (obtido !== e.sha256 || bytes.length !== e.bytes)
      throw new ErroDerivado(`derivado ${slug}: o arquivo não confere com o lock`);
    vistos[slug] = obtido;
  }
  return vistos;
}

export function executar(caminhoLock: string, pastaDerivados: string): { derivados: number } {
  const antigo = JSON.parse(readFileSync(caminhoLock, "utf8")) as LockAntigo;
  const antes = conferirBytes(pastaDerivados, antigo);
  const novo = adicionarRevisao(antigo);
  writeFileSync(caminhoLock, `${JSON.stringify(novo, null, 2)}\n`);
  const depois = conferirBytes(pastaDerivados, novo);
  for (const slug of Object.keys(antes))
    if (antes[slug] !== depois[slug])
      throw new ErroDerivado(`derivado ${slug}: o sha256 mudou durante o passo`);
  return { derivados: Object.keys(antes).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const valor = (flag: string, padrao: string) => {
    const i = process.argv.indexOf(flag);
    return i < 0 ? padrao : path.resolve(process.argv[i + 1] ?? "");
  };
  try {
    const r = executar(valor("--lock", CAMINHO_LOCK), valor("--derivados", PASTA_DERIVADOS));
    console.log(
      `revisao=1 acrescentada a ${r.derivados} derivados; o sha256 de todos continua o mesmo`,
    );
  } catch (erro) {
    console.error(erro instanceof ErroDerivado ? erro.message : "falha ao acrescentar a revisão");
    process.exit(1);
  }
}
