// Registro das ORIGENS do Acervo (`data/acervo-origens.yaml`) e lock do arquivo BRUTO (`data/acervo.lock.json`).
// Uma origem é um conjunto de arquivos de um mesmo lugar, com a mesma licença e o mesmo commit. É código de
// DESENVOLVEDOR (usado por baixar, derivar e verificar): nenhum caminho de carga o importa. Só `node:fs`, `yaml`
// e `zod`; nenhuma rede.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as lerYaml } from "yaml";
import { z } from "zod";

export class ErroOrigem extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroOrigem";
  }
}

export const RAIZ_PRODUTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CAMINHO_ORIGENS = path.join(RAIZ_PRODUTO, "data", "acervo-origens.yaml");
export const CAMINHO_LOCK_BRUTO = path.join(RAIZ_PRODUTO, "data", "acervo.lock.json");
export const PASTA_BRUTO = path.join(RAIZ_PRODUTO, "data", "raw", "acervo");

/** Teto padrão do arquivo bruto (baixado e interpretado). Cada arquivo pode pedir menos no registro. */
export const TETO_BRUTO_BYTES = 32 * 1024 * 1024;

/**
 * Formatos de arquivo de origem que o despachante (`acervo-interpretar`) conhece. Cada plano de origem acrescenta o
 * seu. `texto-ocr` é só REGISTRADO (James 1924 no Internet Archive): ainda não tem verificador de licença nem
 * parser, então nenhum derivado sai dele — o despachante recusa.
 */
export const FORMATOS_ORIGEM = ["tei", "gutenberg", "html", "thml", "texto-ocr"] as const;
export type FormatoOrigem = (typeof FORMATOS_ORIGEM)[number];

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "deve ser kebab-case");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "sha256 em hexadecimal minúsculo");
// Nome de arquivo: nunca separador de caminho, nunca ponto inicial (nada de `..`).
const nomeDeArquivo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "nome de arquivo inválido");
const https = z.string().regex(/^https:\/\/[^\s]+$/, "deve começar por https://");

const esquemaEsperadoParagrafo = z
  .object({
    ref: z.string().min(1),
    contem: z.array(z.string().min(1)).default([]),
    nao_contem: z.array(z.string().min(1)).default([]),
    ref_inicio: z.number().int().min(1).optional(),
    ref_fim: z.number().int().min(1).optional(),
  })
  .strict();

const esquemaEsperado = z
  .object({
    secoes: z.number().int().min(1),
    paragrafos: z.array(esquemaEsperadoParagrafo).default([]),
    // Nenhum parágrafo pode conter o texto de uma nota de editor lida do mesmo arquivo.
    notas_fora_do_texto: z.boolean().default(true),
    // Unidades que a ORIGEM não traz (lacuna no próprio arquivo, ex. "cartas.XLIV" do Gutenberg #2811). A leitura
    // tem de achar EXATAMENTE estas: lacuna que o registro não declara reprova, e declarar o que não falta também.
    // Ausente = a origem não tem lacuna nenhuma.
    ausentes: z.array(z.string().min(1)).optional(),
    // Total de parágrafos do documento inteiro, quando a obra tem uma contagem conhecida (os 114 ditos de Tomé).
    paragrafos_total: z.number().int().min(1).optional(),
  })
  .strict();

const esquemaArquivo = z
  .object({
    id: nomeDeArquivo,
    url: https,
    slug,
    idioma: z.enum(["pt", "en"]),
    limite_bytes: z.number().int().min(1).max(TETO_BRUTO_BYTES).optional(),
    // Como o bruto decodifica (padrão utf-8). O Gutenberg #2811 declara ISO-8859-1 no próprio cabeçalho.
    charset: z.enum(["utf-8", "iso-8859-1"]).optional(),
    // Fatos esperados deste arquivo; quando faltam, valem os da origem (Antiguidades e Guerra: 20 e 7 livros).
    esperado: esquemaEsperado.optional(),
    // Formato `gutenberg`: a estrutura da obra dentro do arquivo e o slug de cada parte, na ordem em que aparecem.
    estrutura: z.enum(["cartas"]).optional(),
    secoes: z.array(slug).min(1).optional(),
    // Formato `html`: a palavra que abre o cabeçalho de cada unidade ("Saying 1: …").
    rotulo_unidade: z.string().min(1).optional(),
    // Formato `thml` (CCEL): qual nível de divisão do arquivo vira seção; o id da divisão é o slug da seção
    // e o id de cada `<p>` (que carrega o da divisão) é a referência do parágrafo.
    divisao_secao: z.enum(["div1", "div2", "div3", "div4"]).optional(),
    // Formato `thml`, volume com várias obras (a coleção de Lightfoot): ids das divisões do nível da seção
    // que pertencem a ESTE arquivo — cada obra do volume é uma entrada de `arquivos` com o seu slug. O volume
    // INTEIRO continua conferido (`esperado` da origem, sobre o arquivo completo); só as divisões listadas
    // saem no derivado. Divisão listada e ausente no bruto reprova: typo nunca vira derivado menor em silêncio.
    divisoes: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const esquemaOrigem = z
  .object({
    nome: z.string().min(1),
    autores: z.array(z.string().min(1)).min(1),
    licenca: z.string().min(1),
    url_licenca: https,
    fonte: https,
    commit: z.string().min(1),
    data_versao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    alteracoes: z.string().min(1),
    formato: z.enum(FORMATOS_ORIGEM),
    publicavel: z.boolean(),
    motivo: z.string().min(1),
    // Lista fechada de unidades (`ref` do parágrafo, ex. "15.44") que PODEM ser publicadas desta origem. Ausente = a
    // origem inteira. Presente = o derivador emite só estas e o `acervo:verify` reprova derivado com outra
    // (vazia também reprova: lista vazia nunca significa "tudo"). Cada unidade entra depois da PRÓPRIA conferência.
    unidades_conferidas: z.array(z.string().min(1)).optional(),
    // Tabela de correspondência de numeração (formato `gutenberg`): `<slug da parte>.<rótulo no arquivo>` →
    // referência moderna. Só as unidades listadas mudam de número; as demais ficam com a numeração da própria
    // origem e o `acervo:verify` as relata. Entrada que não é unidade do arquivo reprova.
    correspondencia_refs: z.record(z.string().min(1), z.string().min(1)).optional(),
    arquivos: z.array(esquemaArquivo).min(1),
    verificador: z
      .object({
        tradutores: z.array(z.string().min(1)).min(1),
        licenca: z.string().min(1),
      })
      .strict(),
    esperado: esquemaEsperado,
  })
  .strict();

export type OrigemAcervo = z.infer<typeof esquemaOrigem>;
export type ArquivoOrigem = OrigemAcervo["arquivos"][number];
export type Esperado = OrigemAcervo["esperado"];

const esquemaOrigens = z.record(slug, esquemaOrigem);
export type Origens = z.infer<typeof esquemaOrigens>;

const esquemaLockBruto = z.object({ arquivos: z.record(z.string().min(1), sha256Hex) }).strict();
export type LockBruto = z.infer<typeof esquemaLockBruto>;

function descrever(erro: z.ZodError): string {
  return erro.issues
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join(".") || "(raiz)"}: ${i.message}`)
    .join("; ");
}

export function lerOrigens(caminho: string = CAMINHO_ORIGENS): Origens {
  let bruto: unknown;
  try {
    bruto = lerYaml(readFileSync(caminho, "utf8"));
  } catch {
    throw new ErroOrigem(`registro de origens ausente ou ilegível: ${path.basename(caminho)}`);
  }
  const r = esquemaOrigens.safeParse(bruto);
  if (!r.success)
    throw new ErroOrigem(`registro de origens fora do contrato: ${descrever(r.error)}`);
  return r.data;
}

/**
 * As unidades que a origem autoriza publicar, ou `undefined` quando a origem não restringe (comportamento de
 * sempre). Lista vazia ou com repetição é erro: nunca vira "tudo" nem "nada" em silêncio.
 */
export function unidadesPermitidas(origem: OrigemAcervo): Set<string> | undefined {
  const lista = origem.unidades_conferidas;
  if (lista === undefined) return undefined;
  if (lista.length === 0)
    throw new ErroOrigem(
      "unidades_conferidas vazia: liste as unidades conferidas ou remova o campo",
    );
  const conjunto = new Set(lista);
  if (conjunto.size !== lista.length)
    throw new ErroOrigem("unidades_conferidas com unidade repetida");
  return conjunto;
}

/**
 * As divisões do volume que pertencem a este arquivo (`divisoes`, formato `thml`), ou `undefined` quando o
 * arquivo é o volume inteiro (comportamento de sempre). Lista vazia ou com repetição é erro.
 */
export function divisoesPermitidas(arquivo: ArquivoOrigem): Set<string> | undefined {
  const lista = arquivo.divisoes;
  if (lista === undefined) return undefined;
  if (lista.length === 0)
    throw new ErroOrigem("divisoes vazia: liste as divisões da obra ou remova o campo");
  const conjunto = new Set(lista);
  if (conjunto.size !== lista.length) throw new ErroOrigem("divisoes com divisão repetida");
  return conjunto;
}

/** Chave do arquivo no lock do bruto e nome da pasta em cache: `<origem>/<arquivo>`. */
export const chaveDoArquivo = (origemId: string, arquivoId: string) => `${origemId}/${arquivoId}`;

export function caminhoDoBruto(pastaBruto: string, origemId: string, arquivoId: string): string {
  return path.join(pastaBruto, origemId, arquivoId);
}

export function lerLockBruto(caminho: string = CAMINHO_LOCK_BRUTO): LockBruto {
  let bruto: unknown;
  try {
    bruto = JSON.parse(readFileSync(caminho, "utf8"));
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return { arquivos: {} };
    throw new ErroOrigem(`lock do bruto ilegível: ${path.basename(caminho)}`);
  }
  const r = esquemaLockBruto.safeParse(bruto);
  if (!r.success) throw new ErroOrigem(`lock do bruto fora do contrato: ${descrever(r.error)}`);
  return r.data;
}

/** Grava o lock com chaves ordenadas: o mesmo conteúdo dá os mesmos bytes. */
export function gravarLockBruto(lock: LockBruto, caminho: string = CAMINHO_LOCK_BRUTO): void {
  const ordenado: Record<string, string> = {};
  for (const k of Object.keys(lock.arquivos).sort()) ordenado[k] = lock.arquivos[k] as string;
  writeFileSync(caminho, `${JSON.stringify({ arquivos: ordenado }, null, 2)}\n`);
}

/** Os fatos esperados que valem para um arquivo: os do próprio arquivo ou, na falta, os da origem. */
export function esperadoDoArquivo(origem: OrigemAcervo, arquivo: ArquivoOrigem): Esperado {
  return arquivo.esperado ?? origem.esperado;
}

/** Acha, em todo o registro, o arquivo que alimenta o derivado `slugDoDerivado`. */
export function acharArquivoDoDerivado(
  origens: Origens,
  slugDoDerivado: string,
): { origemId: string; origem: OrigemAcervo; arquivo: ArquivoOrigem } | null {
  for (const [origemId, origem] of Object.entries(origens)) {
    const arquivo = origem.arquivos.find((a) => a.slug === slugDoDerivado);
    if (arquivo) return { origemId, origem, arquivo };
  }
  return null;
}
