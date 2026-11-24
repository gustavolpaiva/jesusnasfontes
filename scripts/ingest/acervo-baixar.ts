// Baixador de origens do Acervo. Código de DESENVOLVEDOR: roda só na máquina de quem desenvolve; nenhum arquivo do
// caminho de carga o importa (o teste `carga-sem-rede` prova). O arquivo baixado é dado NÃO CONFIÁVEL: o
// sha256 é conferido ANTES de gravar em disco e antes de qualquer interpretação, e o que chega diferente do lock
// é `ErroChecksum`, nunca atualização. O bruto fica em `data/raw/acervo/<origem>/<arquivo>` (git-ignorado).
//
//   pnpm acervo:baixar <origem>            baixa e confere contra o lock (falha se a origem não foi fixada)
//   pnpm acervo:baixar --fixar <origem>    primeira leitura: grava o sha256 no lock; recusa trocar um já gravado

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  caminhoDoBruto,
  chaveDoArquivo,
  ErroOrigem,
  gravarLockBruto,
  type LockBruto,
  lerLockBruto,
  lerOrigens,
  type OrigemAcervo,
  PASTA_BRUTO,
  TETO_BRUTO_BYTES,
} from "./acervo-origens";
import { buscarArquivo, ErroChecksum, type Obter, sha256 } from "./fontes";

export { ErroChecksum };

/**
 * Hosts de onde o Acervo aceita baixar, com o que fixa cada um. Acrescentar um host é decisão revisada, nunca
 * passada por dado.
 *   - fixado por commit: o endereço tem de trazer o `commit` do registro (repositório no GitHub).
 *   - fixado por sha256: a origem não versiona; o endereço é só https + host, e o que fixa o arquivo é o sha256
 *     gravado no lock do bruto por `--fixar` (sem hash no lock, `baixarOrigem` recusa).
 * O endereço principal do Gutenberg (`gutenberg.org`), que bloqueia cliente automatizado, fica FORA da lista de
 * propósito: do Gutenberg só se baixa pelo espelho.
 */
const HOSTS_FIXADOS_POR_COMMIT: readonly string[] = ["raw.githubusercontent.com"];
const HOSTS_FIXADOS_POR_SHA256: readonly string[] = ["gutenberg.pglaf.org", "www.gospels.net"];
export const HOSTS_PERMITIDOS = [...HOSTS_FIXADOS_POR_COMMIT, ...HOSTS_FIXADOS_POR_SHA256] as const;

export function validarUrl(url: string, origem: Pick<OrigemAcervo, "commit">): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErroOrigem(`endereço inválido: ${url}`);
  }
  if (u.protocol !== "https:" || !(HOSTS_PERMITIDOS as readonly string[]).includes(u.hostname))
    throw new ErroOrigem(`host fora da lista permitida: ${u.hostname}`);
  if (HOSTS_FIXADOS_POR_COMMIT.includes(u.hostname) && !url.includes(origem.commit))
    throw new ErroOrigem(`o endereço não está fixado no commit ${origem.commit}: ${url}`);
}

/** Download com teto de tamanho (cabeçalho e fluxo) e sem seguir redirecionamento. */
export function obterComTeto(limite: number = TETO_BRUTO_BYTES): Obter {
  return async (url) => {
    const resposta = await fetch(url, { redirect: "error" });
    if (!resposta.ok) throw new Error(`falha ao baixar ${url}: HTTP ${resposta.status}`);
    const anunciado = Number(resposta.headers.get("content-length") ?? "0");
    if (anunciado > limite) throw new Error(`arquivo acima do teto de ${limite} bytes: ${url}`);
    if (!resposta.body) throw new Error(`resposta sem corpo: ${url}`);
    const partes: Uint8Array[] = [];
    let total = 0;
    const leitor = resposta.body.getReader();
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > limite) {
        await leitor.cancel();
        throw new Error(`arquivo acima do teto de ${limite} bytes: ${url}`);
      }
      partes.push(value);
    }
    return new Uint8Array(Buffer.concat(partes));
  };
}

export type ResultadoBaixa = { chave: string; sha256: string; fixado: boolean };

/**
 * Baixa todos os arquivos de uma origem. Sem `fixar`, cada arquivo precisa já estar no lock e o hash tem de
 * bater. Com `fixar`, o arquivo ainda fora do lock entra com o hash lido; o já presente tem de bater (nunca é
 * trocado). Devolve o lock atualizado SEM gravá-lo (quem chama decide).
 */
export async function baixarOrigem(
  origemId: string,
  origem: OrigemAcervo,
  lock: LockBruto,
  opcoes: { fixar: boolean; pastaBruto?: string; obter?: Obter },
): Promise<{ lock: LockBruto; resultados: ResultadoBaixa[] }> {
  const pasta = opcoes.pastaBruto ?? PASTA_BRUTO;
  const novo: LockBruto = { arquivos: { ...lock.arquivos } };
  const resultados: ResultadoBaixa[] = [];
  for (const arquivo of origem.arquivos) {
    validarUrl(arquivo.url, origem);
    const chave = chaveDoArquivo(origemId, arquivo.id);
    const esperado = lock.arquivos[chave];
    if (!esperado && !opcoes.fixar)
      throw new ErroOrigem(`${chave}: origem não fixada no lock (use --fixar na primeira leitura)`);
    const obter = opcoes.obter ?? obterComTeto(arquivo.limite_bytes ?? TETO_BRUTO_BYTES);
    const r = await buscarArquivo(
      arquivo.url,
      caminhoDoBruto(pasta, origemId, arquivo.id),
      esperado,
      obter,
    );
    // Sem hash esperado `buscarArquivo` grava; aqui a barreira de tamanho vale também para o cache.
    if (r.conteudo.byteLength > (arquivo.limite_bytes ?? TETO_BRUTO_BYTES))
      throw new ErroOrigem(`${chave}: arquivo acima do teto`);
    if (!esperado) novo.arquivos[chave] = sha256(r.conteudo);
    resultados.push({ chave, sha256: r.sha256, fixado: !esperado });
  }
  return { lock: novo, resultados };
}

async function principal(argv: string[]): Promise<number> {
  const fixar = argv.includes("--fixar");
  const ids = argv.filter((a) => !a.startsWith("--"));
  if (ids.length === 0) {
    console.error("uso: pnpm acervo:baixar [--fixar] <origem>…");
    return 2;
  }
  const origens = lerOrigens();
  let lock = lerLockBruto();
  for (const id of ids) {
    const origem = origens[id];
    if (!origem) {
      console.error(`REPROVADO ${id}: origem fora do registro`);
      return 1;
    }
    try {
      const r = await baixarOrigem(id, origem, lock, { fixar });
      lock = r.lock;
      for (const x of r.resultados)
        console.log(`${x.fixado ? "FIXADO" : "OK"} ${x.chave} sha256=${x.sha256}`);
    } catch (erro) {
      console.error(`REPROVADO ${id}: ${(erro as Error).message}`);
      return 1;
    }
  }
  if (fixar) gravarLockBruto(lock);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  principal(process.argv.slice(2)).then(
    (codigo) => process.exit(codigo),
    (erro) => {
      console.error(`acervo:baixar falhou: ${(erro as Error).message}`);
      process.exit(1);
    },
  );
}
