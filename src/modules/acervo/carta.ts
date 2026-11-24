import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as lerYaml } from "yaml";
import { z } from "zod";
import { registrarErro } from "@/lib/registro";

// Carta de neutralidade do Acervo (D-08, UI-SPEC tela 7). O TEXTO É DO DONO: vive em
// `content/acervo/carta-de-neutralidade.md` e nenhum agente o escreve no produto. Enquanto o arquivo não existir,
// `lerCarta` devolve `null`: a rota dá "Página não encontrada" e o link "Por que estas obras?" não aparece em lugar
// nenhum (nunca leva a uma página vazia).
//
// Formato do arquivo: cabeçalho (front matter) com `titulo`, `versao` e `data` (AAAA-MM-DD); depois, parágrafos de
// abertura (o lede) e seções, cada uma começando por uma linha `## Título`. Markdown restrito a título de seção e
// parágrafo: tudo o mais (asteriscos, marcação HTML, links) é texto e aparece como está. Parágrafos se separam por
// linha em branco; linhas seguidas viram um parágrafo só.

export const ARQUIVO_DA_CARTA = "carta-de-neutralidade.md";

export type SecaoDaCarta = { titulo: string; paragrafos: string[] };

export type Carta = {
  titulo: string;
  versao: string;
  /** AAAA-MM-DD */
  data: string;
  lede: string[];
  secoes: SecaoDaCarta[];
};

const esquemaCabecalho = z
  .object({
    titulo: z.string().trim().min(1).max(120),
    versao: z.preprocess(
      (v) => (typeof v === "number" ? String(v) : v),
      z.string().trim().min(1).max(20),
    ),
    // O YAML lê 2026-11-24 como data; volta a texto antes de validar.
    data: z.preprocess(
      (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((d) => !Number.isNaN(Date.parse(d)), "data inexistente"),
    ),
  })
  .strict();

const CABECALHO = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function paragrafosDe(linhas: string[]): string[] {
  const paragrafos: string[] = [];
  let atual: string[] = [];
  const fechar = () => {
    if (atual.length > 0) paragrafos.push(atual.join(" "));
    atual = [];
  };
  for (const linha of linhas) {
    const limpa = linha.trim();
    if (limpa === "") fechar();
    else atual.push(limpa);
  }
  fechar();
  return paragrafos;
}

/** Interpreta o texto do arquivo. Lança em cabeçalho ausente ou inválido; a mensagem nunca traz o texto. */
export function interpretarCarta(conteudo: string): Carta {
  const partes = CABECALHO.exec(conteudo);
  if (!partes) throw new Error("carta sem cabeçalho");
  let bruto: unknown;
  try {
    bruto = lerYaml(partes[1] ?? "");
  } catch {
    throw new Error("cabeçalho da carta ilegível");
  }
  const cabecalho = esquemaCabecalho.safeParse(bruto);
  if (!cabecalho.success) throw new Error("cabeçalho da carta fora do contrato");

  const linhas = (partes[2] ?? "").split(/\r?\n/);
  const abertura: string[] = [];
  const secoes: { titulo: string; linhas: string[] }[] = [];
  for (const linha of linhas) {
    const titulo = /^##\s+(\S.*)$/.exec(linha);
    if (titulo) secoes.push({ titulo: (titulo[1] as string).trim(), linhas: [] });
    else (secoes.at(-1)?.linhas ?? abertura).push(linha);
  }
  return {
    titulo: cabecalho.data.titulo,
    versao: cabecalho.data.versao,
    data: cabecalho.data.data,
    lede: paragrafosDe(abertura),
    secoes: secoes.map((s) => ({ titulo: s.titulo, paragrafos: paragrafosDe(s.linhas) })),
  };
}

/**
 * A pasta da carta. Em teste e na conferência visual, `CARTA_DIR_PARA_TESTE` aponta para uma pasta de fixture; em
 * produção a variável é ignorada (a carta é só a do dono, em `content/acervo`).
 */
export function pastaDaCarta(): string {
  const desvio = process.env.CARTA_DIR_PARA_TESTE;
  if (desvio && process.env.NODE_ENV !== "production") return path.resolve(desvio);
  return path.join(process.cwd(), "content", "acervo");
}

/**
 * Lê a carta publicada pelo dono. `null` quando o arquivo não existe (a carta ainda não foi publicada) e também
 * quando o cabeçalho é inválido: nesse caso o erro vai ao registro só com o contexto e a classe, sem o texto.
 */
export function lerCarta(pasta: string = pastaDaCarta()): Carta | null {
  let conteudo: string;
  try {
    conteudo = readFileSync(path.join(pasta, ARQUIVO_DA_CARTA), "utf8");
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code !== "ENOENT") registrarErro("acervo-carta", erro);
    return null;
  }
  try {
    return interpretarCarta(conteudo);
  } catch (erro) {
    registrarErro("acervo-carta", erro);
    return null;
  }
}
