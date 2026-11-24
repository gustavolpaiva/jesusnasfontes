// `pnpm acervo:verify` — SEM rede, em duas partes. (1) Os derivados versionados contra o lock dos derivados
// (sha256, bytes, orçamento) e contra o registro de origens (a origem existe e é publicável). (2) Quando há
// arquivo bruto em cache: o sha256 contra o lock do bruto, a licença e o tradutor lidos no cabeçalho, o parser e
// cada fato `esperado`, e que o derivado commitado é exatamente o que essa leitura produz. Uma linha por item:
// `OK …`, `REPROVADO …: motivo` ou `SEM BRUTO <origem>` (origem sem cache não reprova: é passo de desenvolvedor).
// Origem não publicável aparece como `NÃO PUBLICÁVEL …: motivo` sem reprovar. Saída 1 se algo reprovar. Nunca
// importa o baixador.

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
import { ErroLicenca } from "./acervo-licenca";
import {
  acharArquivoDoDerivado,
  caminhoDoBruto,
  chaveDoArquivo,
  divisoesPermitidas,
  lerLockBruto,
  lerOrigens,
  type Origens,
  PASTA_BRUTO,
  unidadesPermitidas,
} from "./acervo-origens";
import { slugDaDivisao } from "./acervo-parse-thml";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** Primeiros itens de uma lista e, se ela for longa, o último entre parênteses. */
const listar = (itens: readonly string[], maximo = 5) =>
  `${itens.slice(0, maximo).join(", ")}${itens.length > maximo ? `, … (${itens.at(-1)})` : ""}`;

/** Totais de caracteres por origem: texto (sem notas) e notas de editor removidas, para a projeção do SP-7. */
const totais = (l: { secoes: { paragrafos: { texto: string }[] }[]; notas: string[] }) =>
  `${l.secoes.reduce((n, s) => n + s.paragrafos.reduce((m, p) => m + p.texto.length, 0), 0)} caracteres de texto, ${l.notas.reduce((n, t) => n + t.length, 0)} em notas removidas`;

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

  // Lista de unidades conferidas vazia reprova mesmo sem derivado: lista vazia nunca vale como "tudo".
  for (const [origemId, origem] of Object.entries(origens)) {
    try {
      unidadesPermitidas(origem);
    } catch (erro) {
      reprovar(origemId, (erro as Error).message);
    }
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
        // Origem com lista de unidades conferidas: nada fora dela pode estar no derivado (lista vazia reprova).
        const permitidas = unidadesPermitidas(origem);
        if (permitidas) {
          const fora = d.secoes
            .flatMap((s) => s.paragrafos.map((p) => p.ref))
            .filter((ref) => !permitidas.has(ref));
          if (fora.length > 0)
            throw new ErroDerivado(
              `derivado ${c.slug}: ${fora.length} unidade(s) fora de unidades_conferidas da origem ${d.origem_id} (${fora.slice(0, 5).join(", ")}${fora.length > 5 ? ", …" : ""})`,
            );
        }
        // Arquivo com divisões (volume de várias obras): nenhuma seção fora delas pode estar no derivado.
        const achado = acharArquivoDoDerivado(origens, c.slug);
        const divisoes = achado ? divisoesPermitidas(achado.arquivo) : undefined;
        if (divisoes) {
          const permitidasSlug = new Set([...divisoes].map(slugDaDivisao));
          const fora = d.secoes.filter((s) => !permitidasSlug.has(s.slug)).map((s) => s.slug);
          if (fora.length > 0)
            throw new ErroDerivado(
              `derivado ${c.slug}: ${fora.length} seção(ões) fora das divisões do arquivo (${fora.join(", ")})`,
            );
        }
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
  // Várias Fontes podem vir do MESMO arquivo (volume de várias obras): o relatório do volume é impresso
  // uma vez por arquivo, não uma vez por Fonte. A chave é a LINHA inteira: TOTAIS e AVISO são linhas
  // diferentes e ambas aparecem.
  const volumesReportados = new Set<string>();
  const reportarVolume = (linha: string) => {
    if (volumesReportados.has(linha)) return;
    volumesReportados.add(linha);
    linhas.push(linha);
  };
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
        // O bruto confere em qualquer caso (hash, licença, tradutor, parser, esperado); o aviso da própria edição
        // digital fica registrado mesmo quando a origem é publicável.
        const { interpretado } = conferirBruto({
          origemId,
          origem,
          arquivo,
          bruto: bytes,
          sha256Lock: noLock,
        });
        if (!origem.publicavel) {
          // Origem barrada: dela não sai derivado. Aparece como NÃO PUBLICÁVEL com o motivo.
          linhas.push(
            `NÃO PUBLICÁVEL ${chave}: ${origem.motivo} (bruto confere: ${interpretado.secoes.length} seções, ${interpretado.secoes.reduce((n, s) => n + s.paragrafos.length, 0)} parágrafos)`,
          );
          reportarVolume(`TOTAIS ${chave}: ${totais(interpretado)}`);
          if (interpretado.cabecalho.avisoEditorial)
            reportarVolume(`AVISO ${chave}: ${interpretado.cabecalho.avisoEditorial}`);
          continue;
        }
        if (interpretado.cabecalho.avisoEditorial)
          reportarVolume(`AVISO ${chave}: ${interpretado.cabecalho.avisoEditorial}`);
        // `derivar` confere sha256, licença, tradutor, parser e fatos esperados, nesta ordem.
        const derivado = derivar({ origemId, origem, arquivo, bruto: bytes, sha256Lock: noLock });
        // Quando várias Fontes saem do mesmo arquivo, o slug diz de qual Fonte é esta linha.
        linhas.push(
          `OK ${chave} (${derivado.secoes.length} seções, ${derivado.secoes.reduce((n, s) => n + s.paragrafos.length, 0)} parágrafos, notas fora) — ${arquivo.slug}`,
        );
        reportarVolume(`TOTAIS ${chave}: ${totais(interpretado)}`);
        // Formatos que numeram as unidades relatam o que a origem não traz e o que ficou com a numeração da origem.
        if (interpretado.ausentes?.length)
          linhas.push(
            `AVISO ${chave}: o arquivo de origem não traz ${interpretado.ausentes.length} unidade(s): ${listar(interpretado.ausentes)} (declaradas em esperado.ausentes; o texto que sobrou fica na unidade anterior)`,
          );
        if (interpretado.foraDaTabela?.length)
          linhas.push(
            `NUMERAÇÃO ${chave}: ${interpretado.foraDaTabela.length} unidade(s) fora da tabela de correspondência mantêm a numeração da origem (${listar(interpretado.foraDaTabela)})`,
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
        // Origem barrada POR FALTA DE LICENÇA NO ARQUIVO é o estado que o registro já declara: o sha256 do bruto
        // foi conferido antes (`conferirBruto` só lê a licença depois do hash), e a leitura do arquivo confirma o
        // motivo. Relata, não reprova. Qualquer OUTRO erro de licença num bruto reprova, publicável ou não.
        if (!origem.publicavel && erro instanceof ErroLicenca && erro.codigo === "sem_declaracao") {
          linhas.push(
            `NÃO PUBLICÁVEL ${chave}: ${origem.motivo} (sha256 do bruto confere; leitura do arquivo: ${erro.message})`,
          );
          continue;
        }
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
