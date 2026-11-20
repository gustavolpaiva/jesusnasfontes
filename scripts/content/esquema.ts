// Contrato dos arquivos de conteúdo (front matter dos Estudos e trilhas.yaml) e leitura da pasta,
// sem tocar o banco. `pnpm content:validate` e `pnpm content:load` usam a mesma leitura.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { type Intervalo, parsearReferencia } from "../../src/modules/referencias/parser";
import { type AfirmacaoExtraida, ErroAfirmacao, extrairAfirmacoes } from "./afirmacoes";

// Erro nosso, com texto seguro (nomes de arquivo, campos e referências): pode ir ao terminal.
export class ErroConteudo extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroConteudo";
  }
}

const identificador = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "esperado minúsculas e hífens");
const textoNaoVazio = z.string().min(1);

export const esquemaTrilhas = z
  .array(
    z
      .object({
        id: identificador,
        nome: textoNaoVazio,
        ordem: z.number().int().min(1).max(32767),
        descricao: textoNaoVazio,
      })
      .strict(),
  )
  .min(1);

export const TRADICOES = ["catolica", "ortodoxa", "protestante"] as const;

// Divergência entre tradições (TRIL-08): um tema e a leitura de cada tradição NOMEADA. Duas ou três
// leituras, cada tradição no máximo uma vez; a ordem de exibição é fixa e não vem do arquivo.
const esquemaDivergencia = z
  .object({
    tema: textoNaoVazio,
    leituras: z
      .array(
        z
          .object({ tradicao: z.enum(TRADICOES), resumo: textoNaoVazio })
          .strict(),
      )
      .min(2)
      .max(3)
      .refine((l) => new Set(l.map((x) => x.tradicao)).size === l.length, {
        message: "tradição repetida na mesma Divergência",
      }),
  })
  .strict();

export const GRAUS_DE_CERTEZA = ["consenso", "posicao-majoritaria", "disputada"] as const;

export const esquemaFrontMatter = z
  .object({
    slug: identificador,
    trilha: identificador,
    ordem: z.number().int().min(1).max(32767),
    titulo: textoNaoVazio,
    recorte: z.enum(["historico", "devocional"]),
    minutos: z.number().int().min(1).max(32767).optional(),
    grupo: textoNaoVazio.optional(),
    leitura: z.array(textoNaoVazio).default([]),
    grau_de_certeza: z
      .object({
        valor: z.enum(GRAUS_DE_CERTEZA).nullable(),
        texto: textoNaoVazio,
        revisado: z.boolean(),
      })
      .strict()
      .optional(),
    divergencias: z.array(esquemaDivergencia).default([]),
  })
  .strict();

export type Trilha = z.infer<typeof esquemaTrilhas>[number];
export type FrontMatter = z.infer<typeof esquemaFrontMatter>;

export type PassagemEstudo = {
  ordem: number;
  inicio: number;
  fim: number;
  referenciaTexto: string;
};

export type EstudoLido = {
  arquivo: string;
  frontMatter: FrontMatter;
  corpo: string;
  passagens: PassagemEstudo[];
  afirmacoes: AfirmacaoExtraida[];
  conteudoHash: string;
};

export type ConteudoLido = { trilhas: Trilha[]; estudos: EstudoLido[] };

// Separa o front matter (entre duas cercas `---` no começo do arquivo) do corpo.
export function separarFrontMatter(texto: string): { frontMatter: string; corpo: string } {
  const normal = texto.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(normal);
  if (!m) throw new ErroConteudo("sem front matter entre cercas '---' no começo do arquivo");
  return { frontMatter: m[1] as string, corpo: (m[2] as string).trim() };
}

function mensagensDe(erro: z.ZodError): string {
  return erro.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(raiz)"}: ${i.message}`)
    .join("; ");
}

export function hashDoEstudo(
  fm: FrontMatter,
  corpo: string,
  passagens: readonly PassagemEstudo[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        fm.slug,
        fm.trilha,
        fm.ordem,
        fm.grupo ?? null,
        fm.titulo,
        fm.recorte,
        fm.minutos ?? null,
        corpo,
        fm.grau_de_certeza?.valor ?? null,
        fm.grau_de_certeza?.texto ?? null,
        fm.grau_de_certeza?.revisado ?? false,
        passagens.map((p) => [p.ordem, p.inicio, p.fim, p.referenciaTexto]),
        fm.divergencias.map((d) => [d.tema, d.leituras.map((l) => [l.tradicao, l.resumo])]),
      ]),
    )
    .digest("hex");
}

export function passagensDe(leitura: readonly string[]): PassagemEstudo[] {
  const saida: PassagemEstudo[] = [];
  for (const referencia of leitura) {
    const intervalos: Intervalo[] = parsearReferencia(referencia);
    for (const i of intervalos) {
      saida.push({
        ordem: saida.length + 1,
        inicio: i.inicio,
        fim: i.fim,
        referenciaTexto: referencia,
      });
    }
  }
  return saida;
}

/**
 * Prefixo dos ids de Afirmação do Estudo: `bh` + número da posição (Base histórica) ou `pc` + número
 * (Pontos centrais), com dois dígitos: o Estudo 3 de Pontos centrais leva `pc03-aK`. Outras Trilhas
 * (a Leitura contínua) não levam Afirmações.
 */
export function prefixoDeAfirmacao(trilhaId: string, ordem: number): string | null {
  const numero = String(ordem).padStart(2, "0");
  if (trilhaId === "base-historica") return `bh${numero}`;
  if (trilhaId === "pontos-centrais") return `pc${numero}`;
  return null;
}

const NOME_DE_ESTUDO = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Lê `trilhas/trilhas.yaml` e `trilhas/<trilha>/NN-<slug>.md` e valida tudo sem tocar o banco. */
export async function lerPasta(dir: string): Promise<ConteudoLido> {
  const raizTrilhas = path.join(dir, "trilhas");
  let brutoTrilhas: unknown;
  try {
    brutoTrilhas = parse(await readFile(path.join(raizTrilhas, "trilhas.yaml"), "utf8"));
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT")
      throw new ErroConteudo("trilhas/trilhas.yaml não existe");
    throw new ErroConteudo("trilhas/trilhas.yaml ilegível");
  }
  const t = esquemaTrilhas.safeParse(brutoTrilhas);
  if (!t.success) throw new ErroConteudo(`trilhas/trilhas.yaml: ${mensagensDe(t.error)}`);
  const trilhas = t.data;
  const ids = new Set<string>();
  const ordens = new Set<number>();
  for (const tr of trilhas) {
    if (ids.has(tr.id)) throw new ErroConteudo(`trilhas.yaml: id repetido: ${tr.id}`);
    if (ordens.has(tr.ordem)) throw new ErroConteudo(`trilhas.yaml: ordem repetida: ${tr.ordem}`);
    ids.add(tr.id);
    ordens.add(tr.ordem);
  }

  const estudos: EstudoLido[] = [];
  const slugs = new Map<string, string>();
  const posicoes = new Map<string, string>();
  const idsDeAfirmacao = new Map<string, string>();
  const pastas = (await readdir(raizTrilhas, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const pasta of pastas) {
    if (!ids.has(pasta))
      throw new ErroConteudo(`trilhas/${pasta}: pasta sem Trilha correspondente em trilhas.yaml`);
    const arquivos = (await readdir(path.join(raizTrilhas, pasta)))
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const nome of arquivos) {
      const rotulo = `trilhas/${pasta}/${nome}`;
      const nomeOk = NOME_DE_ESTUDO.exec(nome);
      if (!nomeOk) throw new ErroConteudo(`${rotulo}: o nome deve ser NN-<slug>.md`);
      let separado: { frontMatter: string; corpo: string };
      try {
        separado = separarFrontMatter(await readFile(path.join(raizTrilhas, pasta, nome), "utf8"));
      } catch (erro) {
        throw new ErroConteudo(`${rotulo}: ${(erro as Error).message}`);
      }
      let bruto: unknown;
      try {
        bruto = parse(separado.frontMatter);
      } catch {
        throw new ErroConteudo(`${rotulo}: front matter com YAML inválido`);
      }
      const r = esquemaFrontMatter.safeParse(bruto);
      if (!r.success) throw new ErroConteudo(`${rotulo}: ${mensagensDe(r.error)}`);
      const fm = r.data;
      if (fm.trilha !== pasta)
        throw new ErroConteudo(`${rotulo}: trilha "${fm.trilha}" difere da pasta "${pasta}"`);
      if (fm.slug !== nomeOk[2])
        throw new ErroConteudo(`${rotulo}: slug "${fm.slug}" difere do nome do arquivo`);
      if (fm.ordem !== Number(nomeOk[1]))
        throw new ErroConteudo(`${rotulo}: ordem ${fm.ordem} difere do número do arquivo`);
      if (separado.corpo === "") throw new ErroConteudo(`${rotulo}: corpo vazio`);
      const outroSlug = slugs.get(fm.slug);
      if (outroSlug) throw new ErroConteudo(`${rotulo}: slug repetido, já em ${outroSlug}`);
      slugs.set(fm.slug, rotulo);
      const posicao = `${fm.trilha}#${fm.ordem}`;
      const outraPosicao = posicoes.get(posicao);
      if (outraPosicao) throw new ErroConteudo(`${rotulo}: ordem repetida, já em ${outraPosicao}`);
      posicoes.set(posicao, rotulo);
      let passagens: PassagemEstudo[];
      try {
        passagens = passagensDe(fm.leitura);
      } catch (erro) {
        throw new ErroConteudo(`${rotulo}: leitura inválida: ${(erro as Error).message}`);
      }
      let afirmacoes: AfirmacaoExtraida[];
      try {
        afirmacoes = extrairAfirmacoes(separado.corpo);
      } catch (erro) {
        if (erro instanceof ErroAfirmacao) throw new ErroConteudo(`${rotulo}: ${erro.message}`);
        throw erro;
      }
      const prefixo = prefixoDeAfirmacao(fm.trilha, fm.ordem);
      for (const a of afirmacoes) {
        if (prefixo === null)
          throw new ErroConteudo(`${rotulo}: ${a.id}: esta Trilha não leva Afirmações`);
        if (!a.id.startsWith(`${prefixo}-a`))
          throw new ErroConteudo(`${rotulo}: ${a.id}: o id deve começar por ${prefixo}-a`);
        const outro = idsDeAfirmacao.get(a.id);
        if (outro) throw new ErroConteudo(`${rotulo}: ${a.id}: id já usado em ${outro}`);
        idsDeAfirmacao.set(a.id, rotulo);
      }
      estudos.push({
        arquivo: rotulo,
        frontMatter: fm,
        corpo: separado.corpo,
        passagens,
        afirmacoes,
        conteudoHash: hashDoEstudo(fm, separado.corpo, passagens),
      });
    }
  }
  return { trilhas, estudos };
}
