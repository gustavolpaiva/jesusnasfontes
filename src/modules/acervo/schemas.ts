import { parse as lerYaml } from "yaml";
import { z } from "zod";

// Contrato do Acervo (ACER-02, ACER-08): o YAML de uma Fonte (metadados e resumos escritos por nós) e o
// derivado (o texto já interpretado, versionado no produto). Erro de contrato carrega o NOME do campo e o
// que faltou, nunca o texto da Fonte: a mensagem pode ir ao terminal e ao registro.

export class ErroContrato extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroContrato";
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SMALLINT_MAX = 32767;

export const NIVEIS = ["primaria", "academica", "confessional"] as const;
export type Nivel = (typeof NIVEIS)[number];
export const IDIOMAS = ["pt", "en"] as const;
export type Idioma = (typeof IDIOMAS)[number];

const slug = z.string().regex(SLUG, "deve ser kebab-case (letras minúsculas, números e hífens)");
const textoNaoVazio = z
  .string()
  .refine((t) => t.trim().length > 0, "não pode ser vazio")
  .refine((t) => t.length <= 2_000_000, "grande demais");
const inteiroPositivo = z.number().int().min(1).max(SMALLINT_MAX);

// ───────────────────────── derivado ─────────────────────────

const esquemaParagrafo = z
  .object({
    ref: z.string().regex(REF, "referência inválida"),
    ref_inicio: z.number().int().min(1).nullish(),
    ref_fim: z.number().int().min(1).nullish(),
    texto: textoNaoVazio,
  })
  .strict();

const esquemaSecaoDerivada = z
  .object({
    slug,
    titulo: textoNaoVazio,
    ordem: inteiroPositivo,
    paragrafos: z
      .array(esquemaParagrafo)
      .min(1, "a seção precisa de ao menos um parágrafo")
      .max(SMALLINT_MAX),
  })
  .strict();

export const esquemaDerivado = z
  .object({
    versao_formato: z.literal(1),
    slug,
    idioma: z.enum(IDIOMAS),
    origem_id: z.string().min(1),
    origem_sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 em hexadecimal minúsculo"),
    gerado_por: z.string().min(1),
    secoes: z.array(esquemaSecaoDerivada).min(1, "o derivado precisa de ao menos uma seção"),
  })
  .strict()
  .superRefine((d, ctx) => {
    const slugs = new Set<string>();
    const ordens = new Set<number>();
    const refs = new Set<string>();
    for (const [i, s] of d.secoes.entries()) {
      if (slugs.has(s.slug))
        ctx.addIssue({
          code: "custom",
          path: ["secoes", i, "slug"],
          message: `seção repetida: ${s.slug}`,
        });
      slugs.add(s.slug);
      if (ordens.has(s.ordem))
        ctx.addIssue({ code: "custom", path: ["secoes", i, "ordem"], message: "ordem repetida" });
      ordens.add(s.ordem);
      for (const [j, p] of s.paragrafos.entries()) {
        if (refs.has(p.ref))
          ctx.addIssue({
            code: "custom",
            path: ["secoes", i, "paragrafos", j, "ref"],
            message: `referência repetida: ${p.ref}`,
          });
        refs.add(p.ref);
        const temInicio = p.ref_inicio != null;
        const temFim = p.ref_fim != null;
        if (temInicio !== temFim)
          ctx.addIssue({
            code: "custom",
            path: ["secoes", i, "paragrafos", j, temInicio ? "ref_fim" : "ref_inicio"],
            message: "ref_inicio e ref_fim vêm juntos",
          });
        else if (temInicio && temFim && (p.ref_inicio as number) > (p.ref_fim as number))
          ctx.addIssue({
            code: "custom",
            path: ["secoes", i, "paragrafos", j, "ref_fim"],
            message: "ref_fim não pode ser menor que ref_inicio",
          });
      }
    }
  });
export type Derivado = z.infer<typeof esquemaDerivado>;

// ───────────────────────── YAML da Fonte ─────────────────────────

const esquemaSecaoYaml = z
  .object({
    slug,
    titulo: textoNaoVazio,
    resumo_pt: z.string().min(1).nullish(),
    palavras_chave_pt: z.array(z.string().min(1)).default([]),
  })
  .strict();

const https = z.string().regex(/^https:\/\/[^\s]+$/, "deve começar por https://");

export const esquemaFonteYaml = z
  .object({
    slug,
    titulo: textoNaoVazio,
    autor: z.string().min(1).nullish(),
    epoca: z.string().min(1).nullish(),
    nivel: z.enum(NIVEIS),
    tipo_texto: z.enum(["integral", "ficha"]),
    idioma: z.enum(IDIOMAS),
    publicada: z.boolean(),
    licenca: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]*$/, "código de licença inválido")
      .nullish(),
    licenca_url: https.nullish(),
    origem_nome: z.string().min(1).nullish(),
    origem_url: https.nullish(),
    tradutor: z.string().min(1).nullish(),
    traducao_ano: z.number().int().min(1).max(2100).nullish(),
    edicao: z.string().min(1).nullish(),
    traduzida_por_nos: z.boolean().default(false),
    limites_pt: z.string().min(1).nullish(),
    secoes: z.array(esquemaSecaoYaml).default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    // ACER-09 também no contrato (o banco repete a regra em restrição de linha).
    if (f.tipo_texto === "integral") {
      if (!f.licenca)
        ctx.addIssue({
          code: "custom",
          path: ["licenca"],
          message: "texto integral exige licença",
        });
      if (!f.origem_url)
        ctx.addIssue({
          code: "custom",
          path: ["origem_url"],
          message: "texto integral exige o endereço de origem em https",
        });
      if (!f.origem_nome)
        ctx.addIssue({
          code: "custom",
          path: ["origem_nome"],
          message: "texto integral exige o nome da origem",
        });
    }
    const vistos = new Set<string>();
    for (const [i, s] of f.secoes.entries()) {
      if (vistos.has(s.slug))
        ctx.addIssue({
          code: "custom",
          path: ["secoes", i, "slug"],
          message: `seção repetida: ${s.slug}`,
        });
      vistos.add(s.slug);
    }
  });
export type FonteYaml = z.infer<typeof esquemaFonteYaml>;

// ───────────────────────── leitura ─────────────────────────

function descrever(erro: z.ZodError): string {
  const unrecognized = (i: z.core.$ZodIssue) => i.code === "unrecognized_keys";
  return erro.issues
    .slice(0, 8)
    .map((i) => {
      const caminho = i.path.map(String).join(".");
      if (unrecognized(i)) {
        const chaves = (i as unknown as { keys: string[] }).keys.join(", ");
        return `${caminho ? `${caminho}: ` : ""}campo desconhecido: ${chaves}`;
      }
      return `${caminho || "(raiz)"}: ${i.message}`;
    })
    .join("; ");
}

/** Valida o JSON do derivado. `rotulo` identifica o arquivo na mensagem (nome, nunca conteúdo). */
export function interpretarDerivado(bruto: unknown, rotulo: string): Derivado {
  const r = esquemaDerivado.safeParse(bruto);
  if (!r.success)
    throw new ErroContrato(`derivado ${rotulo} fora do contrato: ${descrever(r.error)}`);
  return r.data;
}

/** Lê e valida o YAML de uma Fonte. */
export function interpretarFonteYaml(conteudo: string, rotulo: string): FonteYaml {
  let bruto: unknown;
  try {
    bruto = lerYaml(conteudo);
  } catch {
    // O erro do analisador cita trechos do arquivo: fica de fora.
    throw new ErroContrato(`YAML ${rotulo} ilegível`);
  }
  const r = esquemaFonteYaml.safeParse(bruto);
  if (!r.success) throw new ErroContrato(`YAML ${rotulo} fora do contrato: ${descrever(r.error)}`);
  return r.data;
}

// ───────────────────────── exibição ─────────────────────────

const ROTULO_LICENCA: Record<string, string> = {
  "dominio-publico": "domínio público",
  "dominio-publico-dedicado": "domínio público, dedicado pelo tradutor",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc-by-4.0": "CC BY 4.0",
};

/** Texto da licença para a tela; código desconhecido aparece como está (nunca some). */
export function rotuloDaLicenca(codigo: string): string {
  return ROTULO_LICENCA[codigo] ?? codigo;
}
