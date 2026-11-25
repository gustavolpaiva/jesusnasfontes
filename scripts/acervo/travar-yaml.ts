// pnpm acervo:travar — trava no lock o YAML de cada Fonte com derivado (plano 02-22, segunda revisão cruzada). O lock
// `data/acervo-derivados.lock.json` versiona a ENTRADA da carga: o derivado e o YAML (`scripts/acervo/entrada.ts`). Quem
// edita um YAML de Fonte (título, licença, origem, resumo…) roda este comando e faz o commit do lock: o `yaml_sha256` da
// entrada passa a ser o do YAML de agora e a `revisao` SOBE em 1. Sem isso a carga recusa a Fonte ("o YAML mudou sem a
// revisão subir"), porque a revisão é o que impede um build de uma versão anterior de sobrescrever o que foi corrigido.
//
// Entrada ainda "não travada" (sem `yaml_sha256`, ou o valor zerado de um derivado novo) recebe o do YAML de agora SEM
// subir a revisão: não havia YAML anterior para ser corrigido. Não toca em derivado nenhum.
//
//   pnpm acervo:travar [--lock <arquivo>] [--fontes <pasta>]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { interpretarFonteYaml } from "../../src/modules/acervo/schemas";
import { CAMINHO_LOCK, ErroDerivado, lerLock } from "./derivados";
import { hashDoYaml, YAML_NAO_TRAVADO } from "./entrada";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PASTA_FONTES = path.join(RAIZ, "content", "acervo", "fontes");

type EntradaBruta = {
  sha256: string;
  bytes: number;
  yaml_sha256?: string;
  revisao: number;
  [outra: string]: unknown;
};
type LockBruto = { derivados: Record<string, EntradaBruta>; [outra: string]: unknown };

export type ResultadoDeTravar = {
  /** Entradas que receberam o YAML pela primeira vez (a revisão não subiu). */
  travadas: string[];
  /** Entradas cujo YAML mudou: o sha256 foi atualizado e a revisão subiu. */
  revisadas: string[];
};

export function travar(caminhoLock: string, pastaFontes: string): ResultadoDeTravar {
  const lock = JSON.parse(readFileSync(caminhoLock, "utf8")) as LockBruto;
  const yamlPorSlug = new Map<string, string>();
  for (const nome of readdirSync(pastaFontes)
    .filter((n) => n.endsWith(".yaml"))
    .sort()) {
    const fonte = interpretarFonteYaml(readFileSync(path.join(pastaFontes, nome), "utf8"), nome);
    yamlPorSlug.set(fonte.slug, hashDoYaml(fonte));
  }
  const resultado: ResultadoDeTravar = { travadas: [], revisadas: [] };
  const derivados: Record<string, EntradaBruta> = {};
  for (const [slug, e] of Object.entries(lock.derivados)) {
    const yaml = yamlPorSlug.get(slug);
    if (!yaml) throw new ErroDerivado(`derivado ${slug}: não há YAML de Fonte com esse slug`);
    if (e.yaml_sha256 === yaml) {
      derivados[slug] = e;
    } else if (e.yaml_sha256 === undefined || e.yaml_sha256 === YAML_NAO_TRAVADO) {
      derivados[slug] = { sha256: e.sha256, bytes: e.bytes, yaml_sha256: yaml, revisao: e.revisao };
      resultado.travadas.push(slug);
    } else {
      derivados[slug] = {
        sha256: e.sha256,
        bytes: e.bytes,
        yaml_sha256: yaml,
        revisao: e.revisao + 1,
      };
      resultado.revisadas.push(slug);
    }
  }
  const novo = { ...lock, derivados };
  writeFileSync(caminhoLock, `${JSON.stringify(novo, null, 2)}\n`);
  lerLock(caminhoLock); // o lock gravado tem de passar pelo contrato
  return resultado;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const valor = (flag: string, padrao: string) => {
    const i = process.argv.indexOf(flag);
    return i < 0 ? padrao : path.resolve(process.argv[i + 1] ?? "");
  };
  try {
    const r = travar(valor("--lock", CAMINHO_LOCK), valor("--fontes", PASTA_FONTES));
    console.log(
      `acervo:travar: ${r.travadas.length} travadas pela primeira vez, ${r.revisadas.length} com a revisão subida`,
    );
    for (const slug of r.revisadas) console.log(`revisão subida: ${slug}`);
  } catch (erro) {
    console.error(erro instanceof ErroDerivado ? erro.message : "falha ao travar os YAMLs");
    process.exit(1);
  }
}
