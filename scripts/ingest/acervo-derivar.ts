// `pnpm acervo:derivar <slug>…` — passo de DESENVOLVEDOR: do arquivo bruto verificado ao derivado versionado.
// Ordem fixa e cada passo falha em voz alta: (1) a origem é publicável? (2) o sha256 do bruto confere com o lock
// do bruto; (3) licença e tradutor lidos no cabeçalho; (4) o parser; (5) os fatos esperados da origem; (6) o
// contrato do derivado; (7) o orçamento de tamanho. Só depois grava `data/acervo-derivados/<slug>.json` e
// atualiza o lock dos derivados, e o JSON é determinístico: mesma entrada, mesmos bytes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Derivado, interpretarDerivado } from "../../src/modules/acervo/schemas";
import {
  CAMINHO_LOCK as CAMINHO_LOCK_DERIVADOS,
  lerLock as lerLockDerivados,
  PASTA_DERIVADOS,
} from "../acervo/derivados";
import { interpretarOrigem, type ResultadoInterpretado } from "./acervo-interpretar";
import {
  type ArquivoOrigem,
  acharArquivoDoDerivado,
  caminhoDoBruto,
  chaveDoArquivo,
  ErroOrigem,
  type Esperado,
  esperadoDoArquivo,
  type LockBruto,
  lerLockBruto,
  lerOrigens,
  type OrigemAcervo,
  PASTA_BRUTO,
  TETO_BRUTO_BYTES,
} from "./acervo-origens";
import type { ResultadoTei } from "./acervo-parse-tei";
import { ErroChecksum } from "./fontes";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export const VERSAO_DERIVADOR = "acervo-derivar 1";

export type EntradaDerivar = {
  origemId: string;
  origem: OrigemAcervo;
  arquivo: ArquivoOrigem;
  bruto: Uint8Array;
  /** sha256 do bruto registrado no lock; ausente = origem não fixada (recusa). */
  sha256Lock: string | undefined;
  rotuloLivro?: string;
};

/** Confere os fatos esperados da origem contra o que o parser leu. Devolve as falhas (vazio = tudo confere). */
export function conferirEsperado(tei: ResultadoTei, esperado: Esperado): string[] {
  const falhas: string[] = [];
  if (tei.secoes.length !== esperado.secoes)
    falhas.push(`esperadas ${esperado.secoes} seções, lidas ${tei.secoes.length}`);
  const porRef = new Map(tei.secoes.flatMap((s) => s.paragrafos).map((p) => [p.ref, p]));
  for (const e of esperado.paragrafos) {
    const p = porRef.get(e.ref);
    if (!p) {
      falhas.push(`parágrafo ${e.ref} ausente`);
      continue;
    }
    for (const t of e.contem) if (!p.texto.includes(t)) falhas.push(`${e.ref} não contém "${t}"`);
    for (const t of e.nao_contem) if (p.texto.includes(t)) falhas.push(`${e.ref} contém "${t}"`);
    if (e.ref_inicio !== undefined && p.ref_inicio !== e.ref_inicio)
      falhas.push(`${e.ref}: ref_inicio ${p.ref_inicio}, esperado ${e.ref_inicio}`);
    if (e.ref_fim !== undefined && p.ref_fim !== e.ref_fim)
      falhas.push(`${e.ref}: ref_fim ${p.ref_fim}, esperado ${e.ref_fim}`);
  }
  if (esperado.notas_fora_do_texto) {
    // Nota curta demais ("Ibid.") apareceria por acaso no texto; as de 40+ caracteres são o sinal.
    const notas = [...new Set(tei.notas.filter((n) => n.length >= 40))];
    const textos = tei.secoes.flatMap((s) => s.paragrafos.map((p) => ({ ref: p.ref, t: p.texto })));
    for (const nota of notas) {
      const achado = textos.find((x) => x.t.includes(nota));
      if (achado) falhas.push(`texto de nota de editor dentro do parágrafo ${achado.ref}`);
    }
  }
  return falhas;
}

/** Serialização determinística: ordem fixa de chaves, dois espaços, quebra de linha final, sem data. */
export function serializar(derivado: Derivado): string {
  return `${JSON.stringify(derivado, null, 2)}\n`;
}

/**
 * Confere o bruto SEM decidir se a origem é publicável: tamanho, sha256 contra o lock, licença e tradutor lidos no
 * cabeçalho, parser e fatos esperados, nesta ordem. É o que o `acervo:verify` usa para a origem barrada
 * (`publicavel: false`), cujo bruto continua tendo de conferir. Não toca o disco.
 */
export function conferirBruto(entrada: EntradaDerivar): {
  interpretado: ResultadoInterpretado;
  sha256: string;
} {
  const { origemId, origem, arquivo, bruto } = entrada;
  const chave = chaveDoArquivo(origemId, arquivo.id);
  if (!entrada.sha256Lock)
    throw new ErroOrigem(`${chave}: sem sha256 no lock do bruto (rode acervo:baixar --fixar)`);
  const obtido = sha256(bruto);
  if (obtido !== entrada.sha256Lock) throw new ErroChecksum(chave, entrada.sha256Lock, obtido);
  if (bruto.byteLength > (arquivo.limite_bytes ?? TETO_BRUTO_BYTES))
    throw new ErroOrigem(`${chave}: arquivo bruto acima do teto`);

  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bruto);
  const interpretado = interpretarOrigem(origem.formato, xml, {
    verificador: origem.verificador,
    rotuloLivro: entrada.rotuloLivro,
  });
  const falhas = conferirEsperado(interpretado, esperadoDoArquivo(origem, arquivo));
  if (falhas.length > 0)
    throw new ErroOrigem(`${chave}: a leitura não confere com o esperado: ${falhas.join("; ")}`);
  return { interpretado, sha256: obtido };
}

/**
 * Bruto verificado para derivado. Não toca o disco. Lança antes de ler o conteúdo se a origem não é publicável
 * ou se o sha256 não confere; lança `ErroLicenca` se o cabeçalho diverge do registro.
 */
export function derivar(entrada: EntradaDerivar): Derivado {
  const { origemId, origem, arquivo } = entrada;
  if (!origem.publicavel)
    throw new ErroOrigem(
      `origem ${origemId} não é publicável (${origem.motivo}); derivação recusada`,
    );
  const { interpretado: tei, sha256: obtido } = conferirBruto(entrada);

  return interpretarDerivado(
    {
      versao_formato: 1,
      slug: arquivo.slug,
      idioma: arquivo.idioma,
      origem_id: origemId,
      origem_sha256: obtido,
      gerado_por: `${VERSAO_DERIVADOR}; origem ${origemId} commit ${origem.commit}`,
      secoes: tei.secoes.map((s) => ({
        slug: s.slug,
        titulo: s.titulo,
        ordem: s.ordem,
        paragrafos: s.paragrafos.map((p) => ({
          ref: p.ref,
          // A faixa só existe quando o arquivo a dá (a última seção do livro não tem fim conhecido).
          ...(p.ref_inicio !== null && p.ref_fim !== null
            ? { ref_inicio: p.ref_inicio, ref_fim: p.ref_fim }
            : {}),
          texto: p.texto,
        })),
      })),
    },
    arquivo.slug,
  );
}

export type OpcoesCli = {
  origens?: string;
  lockBruto?: string;
  bruto?: string;
  derivados?: string;
  lockDerivados?: string;
};

export type ResultadoDerivacao = { slug: string; bytes: number; sha256: string };

/** Deriva `slug`, confere o orçamento e SÓ ENTÃO grava o arquivo e o lock dos derivados. */
export function derivarParaDisco(slug: string, opcoes: OpcoesCli = {}): ResultadoDerivacao {
  const origens = lerOrigens(opcoes.origens);
  const lockBruto: LockBruto = lerLockBruto(opcoes.lockBruto);
  const pastaBruto = opcoes.bruto ?? PASTA_BRUTO;
  const pastaDerivados = opcoes.derivados ?? PASTA_DERIVADOS;
  const caminhoLock = opcoes.lockDerivados ?? CAMINHO_LOCK_DERIVADOS;

  const achado = acharArquivoDoDerivado(origens, slug);
  if (!achado) throw new ErroOrigem(`derivado ${slug}: nenhuma origem do registro o produz`);
  const caminhoBruto = caminhoDoBruto(pastaBruto, achado.origemId, achado.arquivo.id);
  if (!existsSync(caminhoBruto))
    throw new ErroOrigem(`${slug}: bruto ausente em cache (rode acervo:baixar ${achado.origemId})`);

  const derivado = derivar({
    ...achado,
    bruto: new Uint8Array(readFileSync(caminhoBruto)),
    sha256Lock: lockBruto.arquivos[chaveDoArquivo(achado.origemId, achado.arquivo.id)],
  });
  const conteudo = serializar(derivado);
  const bytes = Buffer.byteLength(conteudo, "utf8");

  const lock = lerLockDerivados(caminhoLock);
  if (bytes > lock.orcamento_arquivo_bytes)
    throw new ErroOrigem(
      `derivado ${slug}: acima de orcamento_arquivo_bytes (limite ${lock.orcamento_arquivo_bytes}, medido ${bytes})`,
    );
  const soma =
    Object.entries(lock.derivados)
      .filter(([s]) => s !== slug)
      .reduce((acc, [, v]) => acc + v.bytes, 0) + bytes;
  if (soma > lock.orcamento_total_bytes)
    throw new ErroOrigem(
      `derivados: soma acima de orcamento_total_bytes (limite ${lock.orcamento_total_bytes}, medido ${soma})`,
    );

  const hash = sha256(conteudo);
  mkdirSync(pastaDerivados, { recursive: true });
  writeFileSync(path.join(pastaDerivados, `${slug}.json`), conteudo);
  const derivados: Record<string, { sha256: string; bytes: number }> = {
    ...lock.derivados,
    [slug]: { sha256: hash, bytes },
  };
  const ordenado: Record<string, { sha256: string; bytes: number }> = {};
  for (const k of Object.keys(derivados).sort()) ordenado[k] = derivados[k] as never;
  writeFileSync(
    caminhoLock,
    `${JSON.stringify(
      {
        orcamento_arquivo_bytes: lock.orcamento_arquivo_bytes,
        orcamento_total_bytes: lock.orcamento_total_bytes,
        derivados: ordenado,
      },
      null,
      2,
    )}\n`,
  );
  return { slug, bytes, sha256: hash };
}

function lerOpcoes(argv: string[]): { slugs: string[]; opcoes: OpcoesCli } {
  const opcoes: OpcoesCli = {};
  const slugs: string[] = [];
  const mapa: Record<string, keyof OpcoesCli> = {
    "--origens": "origens",
    "--lock-bruto": "lockBruto",
    "--bruto": "bruto",
    "--derivados": "derivados",
    "--lock-derivados": "lockDerivados",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const chave = mapa[a];
    if (chave) opcoes[chave] = argv[++i];
    else slugs.push(a);
  }
  return { slugs, opcoes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { slugs, opcoes } = lerOpcoes(process.argv.slice(2));
  if (slugs.length === 0) {
    console.error("uso: pnpm acervo:derivar <slug>…");
    process.exit(2);
  }
  let codigo = 0;
  for (const slug of slugs) {
    try {
      const r = derivarParaDisco(slug, opcoes);
      console.log(`DERIVADO ${r.slug} bytes=${r.bytes} sha256=${r.sha256}`);
    } catch (erro) {
      console.error(`REPROVADO ${slug}: ${(erro as Error).message}`);
      codigo = 1;
    }
  }
  process.exit(codigo);
}
