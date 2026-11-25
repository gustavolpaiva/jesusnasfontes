import { readFileSync } from "node:fs";
import path from "node:path";
import { hashDoYaml } from "../../scripts/acervo/entrada";
import { interpretarFonteYaml } from "../../src/modules/acervo/schemas";

/** O `yaml_sha256` que o lock tem de trazer para o YAML de Fonte deste arquivo (o mesmo que `pnpm acervo:travar` grava). */
export function yamlSha256DoArquivo(caminho: string): string {
  return hashDoYaml(interpretarFonteYaml(readFileSync(caminho, "utf8"), path.basename(caminho)));
}
