// pnpm ingest:verify — baixa os 132 arquivos no commit fixado, confere o sha256 de cada um contra o lock
// ANTES de interpretar, interpreta e valida as duas edições. Exit 1 em qualquer divergência.
// --atualizar-lock grava o lock (uso único; depois o lock é a lei). --impressao imprime o hash do que foi interpretado.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buscarArquivo,
  CAMINHO_LOCK,
  COMMIT_BIBLIA_LIVRE,
  DIR_RAW,
  EDICOES,
  type Edicao,
  type Lock,
  lerLock,
  lerRegistro,
  urlArquivo,
} from "./fontes";
import { carregarTabela, interpretarF4, mapaDePrefixos, type Versiculo } from "./parser-f4";
import { validarEdicao } from "./validar";

const LOTE = 8;

async function emLotes<T>(itens: readonly T[], f: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < itens.length; i += LOTE) {
    await Promise.all(itens.slice(i, i + LOTE).map(f));
  }
}

export type LinhaSaida = {
  edicao: Edicao;
  versiculos: number;
  capitulos: number;
  excecoes: number;
  semTexto: string[];
};

export async function verificar(opcoes: { atualizarLock?: boolean } = {}): Promise<{
  linhas: LinhaSaida[];
  correcoesAplicadas: number;
  impressao: string;
}> {
  const registro = await lerRegistro();
  const tabela = carregarTabela();
  const mapa = mapaDePrefixos(tabela);
  const pares = EDICOES.flatMap((edicao) => tabela.map((l) => ({ edicao, arquivo: l.arquivo })));

  if (opcoes.atualizarLock) {
    const arquivos: Record<string, string> = {};
    await emLotes(pares, async ({ edicao, arquivo }) => {
      const r = await buscarArquivo(
        urlArquivo(edicao, arquivo),
        path.join(DIR_RAW, edicao, arquivo),
      );
      arquivos[`${edicao}/${arquivo}`] = r.sha256;
    });
    const ordenado: Record<string, string> = {};
    for (const k of Object.keys(arquivos).sort()) ordenado[k] = arquivos[k] as string;
    const lock: Lock = { commit: COMMIT_BIBLIA_LIVRE, arquivos: ordenado };
    await writeFile(CAMINHO_LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  }

  const lock = await lerLock();
  if (!registro.esperado) throw new Error("datasets.yaml sem esperado");
  const nomesRegistrados = new Set(pares.map((p) => `${p.edicao}/${p.arquivo}`));
  for (const k of Object.keys(lock.arquivos)) {
    if (!nomesRegistrados.has(k))
      throw new Error(`o lock cita arquivo fora da tabela de livros: ${k}`);
  }
  for (const c of registro.correcoes_marcacao) {
    if (!nomesRegistrados.has(`${c.edicao}/${c.arquivo}`)) {
      throw new Error(`correção para arquivo desconhecido: ${c.edicao}/${c.arquivo}`);
    }
  }

  // 1) Tudo baixado e conferido contra o lock antes de interpretar qualquer arquivo.
  const conteudos = new Map<string, Uint8Array>();
  await emLotes(pares, async ({ edicao, arquivo }) => {
    const chaveLock = `${edicao}/${arquivo}`;
    const esperado = lock.arquivos[chaveLock];
    if (!esperado) throw new Error(`o lock não tem ${chaveLock}`);
    const r = await buscarArquivo(
      urlArquivo(edicao, arquivo),
      path.join(DIR_RAW, edicao, arquivo),
      esperado,
    );
    conteudos.set(chaveLock, r.conteudo);
  });
  if (Object.keys(lock.arquivos).length !== pares.length) {
    throw new Error(
      `o lock tem ${Object.keys(lock.arquivos).length} arquivos, esperava ${pares.length}`,
    );
  }

  // 2) Interpretar e validar, edição por edição.
  const linhas: LinhaSaida[] = [];
  const hash = createHash("sha256");
  const chavesPorEdicao = new Map<Edicao, number[]>();
  let correcoesAplicadas = 0;
  for (const edicao of EDICOES) {
    const todos: Versiculo[] = [];
    for (const l of tabela) {
      const nome = `${edicao}/${l.arquivo}`;
      const correcoes = registro.correcoes_marcacao.filter(
        (c) => c.edicao === edicao && c.arquivo === l.arquivo,
      );
      const rel = { correcoesAplicadas: 0 };
      const texto = new TextDecoder("utf-8", { fatal: true }).decode(conteudos.get(nome));
      const vs = interpretarF4(texto, mapa, correcoes, rel);
      correcoesAplicadas += rel.correcoesAplicadas;
      for (const v of vs) {
        if (Math.floor(v.chave / 1_000_000) !== l.livro) {
          throw new Error(`${nome}: versículo de outro livro (${v.chave})`);
        }
      }
      todos.push(...vs);
    }
    const r = validarEdicao(todos, registro.esperado, edicao);
    linhas.push({
      edicao,
      versiculos: r.versiculos,
      capitulos: r.capitulos,
      excecoes: r.excecoes,
      semTexto: r.semTexto,
    });
    chavesPorEdicao.set(
      edicao,
      todos.map((v) => v.chave),
    );
    hash.update(JSON.stringify([edicao, todos]));
  }
  if (correcoesAplicadas !== registro.correcoes_marcacao.length) {
    throw new Error(
      `${correcoesAplicadas} correções aplicadas, o registro lista ${registro.correcoes_marcacao.length}`,
    );
  }
  const [a, b] = EDICOES.map((e) => chavesPorEdicao.get(e) ?? []);
  if (!a || !b || a.length !== b.length || a.some((k, i) => k !== b[i])) {
    throw new Error("as duas edições não têm o mesmo conjunto de ids");
  }
  return { linhas, correcoesAplicadas, impressao: hash.digest("hex") };
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const r = await verificar({ atualizarLock: args.includes("--atualizar-lock") });
  for (const l of r.linhas) {
    process.stdout.write(
      `edicao=${l.edicao} versiculos=${l.versiculos} capitulos=${l.capitulos} excecoes=${l.excecoes}\n`,
    );
  }
  for (const l of r.linhas) {
    for (const ref of l.semTexto)
      process.stdout.write(`sem_texto edicao=${l.edicao} versiculo=${ref}\n`);
  }
  if (args.includes("--impressao")) process.stdout.write(`impressao=${r.impressao}\n`);
  process.stdout.write("verificacao: ok\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro: unknown) => {
    process.stderr.write(
      `verificacao: FALHOU\n${erro instanceof Error ? erro.message : String(erro)}\n`,
    );
    process.exit(1);
  });
}
