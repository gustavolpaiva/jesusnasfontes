// `pnpm acervo:verify` — SEM rede, em duas partes. (1) Os derivados versionados contra o lock dos derivados
// (sha256, bytes, orçamento) e contra o registro de origens (a origem existe e é publicável). (2) Quando há
// arquivo bruto em cache: o sha256 contra o lock do bruto, a licença e o tradutor lidos no cabeçalho, o parser e
// cada fato `esperado`, e que o derivado commitado é exatamente o que essa leitura produz. Uma linha por item:
// `OK …`, `REPROVADO …: motivo` ou `SEM BRUTO <origem>` (origem sem cache não reprova: é passo de desenvolvedor).
// Saída 1 se algo reprovar. Nunca importa o baixador.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAMINHO_LOCK,
  ErroDerivado,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "../acervo/derivados";
import { conferirBruto, derivar, serializar } from "./acervo-derivar";
import {
  caminhoDoBruto,
  chaveDoArquivo,
  lerLockBruto,
  lerOrigens,
  type Origens,
  PASTA_BRUTO,
} from "./acervo-origens";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export type OpcoesVerificar = {
  origens?: string;
  lockBruto?: string;
  bruto?: string;
  derivados?: string;
  lockDerivados?: string;
};

export type ResultadoVerificar = { linhas: string[]; reprovados: number; codigo: 0 | 1 };

export function verificarAcervo(opcoes: OpcoesVerificar = {}): ResultadoVerificar {
  const linhas: string[] = [];
  let reprovados = 0;
  const reprovar = (quem: string, motivo: string) => {
    reprovados++;
    linhas.push(`REPROVADO ${quem}: ${motivo}`);
  };
  const pastaDerivados = opcoes.derivados ?? PASTA_DERIVADOS;
  const pastaBruto = opcoes.bruto ?? PASTA_BRUTO;

  let origens: Origens;
  try {
    origens = lerOrigens(opcoes.origens);
  } catch (erro) {
    reprovar("origens", (erro as Error).message);
    return { linhas, reprovados, codigo: 1 };
  }

  // Parte 1: derivados (sempre).
  const slugsConferidos = new Set<string>();
  try {
    const lock = lerLock(opcoes.lockDerivados ?? CAMINHO_LOCK);
    const conferidos = verificarDerivados(pastaDerivados, lock);
    for (const c of conferidos) {
      try {
        const d = lerDerivado(pastaDerivados, lock, c.slug);
        const origem = origens[d.origem_id];
        if (!origem)
          throw new ErroDerivado(`derivado ${c.slug}: origem ${d.origem_id} fora do registro`);
        if (!origem.publicavel)
          throw new ErroDerivado(`derivado ${c.slug}: a origem ${d.origem_id} não é publicável`);
        slugsConferidos.add(c.slug);
        linhas.push(`OK ${c.slug} (${c.bytes} bytes, sha256 ${c.sha256.slice(0, 12)})`);
      } catch (erro) {
        reprovar(c.slug, (erro as Error).message);
      }
    }
    if (conferidos.length === 0) linhas.push("OK derivados (nenhum derivado no lock)");
  } catch (erro) {
    reprovar("derivados", (erro as Error).message);
  }

  // Parte 2: bruto em cache (só quando existe).
  let lockBruto: ReturnType<typeof lerLockBruto> | undefined;
  try {
    lockBruto = lerLockBruto(opcoes.lockBruto);
  } catch (erro) {
    reprovar("lock do bruto", (erro as Error).message);
  }
  for (const [origemId, origem] of Object.entries(origens)) {
    const presentes = origem.arquivos.filter((a) =>
      existsSync(caminhoDoBruto(pastaBruto, origemId, a.id)),
    );
    if (presentes.length === 0 || !lockBruto) {
      if (presentes.length === 0) linhas.push(`SEM BRUTO ${origemId}`);
      continue;
    }
    for (const arquivo of presentes) {
      const chave = chaveDoArquivo(origemId, arquivo.id);
      try {
        const bytes = new Uint8Array(
          readFileSync(caminhoDoBruto(pastaBruto, origemId, arquivo.id)),
        );
        const noLock = lockBruto.arquivos[chave];
        if (!noLock) throw new Error("arquivo bruto fora do lock (rode acervo:baixar --fixar)");
        if (!origem.publicavel) {
          // Origem barrada: o bruto continua tendo de conferir (hash, licença, tradutor, esperado), mas dela não
          // sai derivado. Aparece como NÃO PUBLICÁVEL e o aviso da própria edição fica registrado.
          const { interpretado } = conferirBruto({
            origemId,
            origem,
            arquivo,
            bruto: bytes,
            sha256Lock: noLock,
          });
          linhas.push(
            `NÃO PUBLICÁVEL ${chave}: ${origem.motivo} (bruto confere: ${interpretado.secoes.length} seções, ${interpretado.secoes.reduce((n, s) => n + s.paragrafos.length, 0)} parágrafos)`,
          );
          if (interpretado.cabecalho.avisoEditorial)
            linhas.push(`AVISO ${chave}: ${interpretado.cabecalho.avisoEditorial}`);
          continue;
        }
        // `derivar` confere sha256, licença, tradutor, parser e fatos esperados, nesta ordem.
        const derivado = derivar({ origemId, origem, arquivo, bruto: bytes, sha256Lock: noLock });
        linhas.push(
          `OK ${chave} (${derivado.secoes.length} seções, ${derivado.secoes.reduce((n, s) => n + s.paragrafos.length, 0)} parágrafos, notas fora)`,
        );
        const caminhoDerivado = path.join(pastaDerivados, `${arquivo.slug}.json`);
        if (slugsConferidos.has(arquivo.slug) && existsSync(caminhoDerivado)) {
          const esperado = sha256(serializar(derivado));
          const emDisco = sha256(readFileSync(caminhoDerivado));
          if (esperado !== emDisco)
            reprovar(
              arquivo.slug,
              "o derivado commitado não é o que o bruto produz (derive de novo)",
            );
          else linhas.push(`OK ${arquivo.slug} reproduz a partir do bruto`);
        }
      } catch (erro) {
        reprovar(chave, (erro as Error).message);
      }
    }
  }

  return { linhas, reprovados, codigo: reprovados > 0 ? 1 : 0 };
}

function lerOpcoes(argv: string[]): OpcoesVerificar {
  const mapa: Record<string, keyof OpcoesVerificar> = {
    "--origens": "origens",
    "--lock-bruto": "lockBruto",
    "--bruto": "bruto",
    "--derivados": "derivados",
    "--lock-derivados": "lockDerivados",
  };
  const opcoes: OpcoesVerificar = {};
  for (let i = 0; i < argv.length; i++) {
    const chave = mapa[argv[i] as string];
    if (chave) opcoes[chave] = argv[++i];
  }
  return opcoes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = verificarAcervo(lerOpcoes(process.argv.slice(2)));
  for (const l of r.linhas) console.log(l);
  process.exit(r.codigo);
}
