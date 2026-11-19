// pnpm content:validate [--dir <pasta>] — valida content/ sem tocar o banco: esquema do front matter,
// referências, slugs únicos, posições únicas e Trilhas existentes. Sai 1 em qualquer defeito.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { registrarErro } from "../../src/lib/registro";
import { PASTA_PADRAO } from "./carregar";
import { ErroConteudo, lerPasta } from "./esquema";

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--dir");
  const dir = i >= 0 ? path.resolve(args[i + 1] ?? "") : PASTA_PADRAO;
  const conteudo = await lerPasta(dir);
  const porTrilha = conteudo.trilhas
    .map((t) => `${t.id}=${conteudo.estudos.filter((e) => e.frontMatter.trilha === t.id).length}`)
    .join(" ");
  const passagens = conteudo.estudos.reduce((s, e) => s + e.passagens.length, 0);
  console.log(`conteudo: ok trilhas=${conteudo.trilhas.length} estudos=${conteudo.estudos.length} passagens=${passagens}`);
  console.log(`estudos por trilha: ${porTrilha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro: unknown) => {
    if (erro instanceof ErroConteudo) console.error(`conteudo: FALHOU\n${erro.message}`);
    else registrarErro("content-validate", erro);
    process.exit(1);
  });
}
