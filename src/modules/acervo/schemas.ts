import { parse as lerYaml } from "yaml";
import { z } from "zod";
import { licencaCitaATraducao, licencaValida } from "./licenca-exibida";

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
    // Vocabulário fechado (licenca-exibida.ts): o texto de licença na tela é jurídico e não varia por redação.
    licenca: z
      .string()
      .refine(licencaValida, "código de licença fora do vocabulário (ver licenca-exibida.ts)")
      .nullish(),
    licenca_url: https.nullish(),
    origem_nome: z.string().min(1).nullish(),
    origem_url: https.nullish(),
    // QUEM traduziu ESTA obra (ausente quando a origem não o nomeia: a página diz "tradutor não identificado na
    // edição" e nunca inventa um). Editor do volume NÃO é tradutor: vai em `editor`.
    tradutor: z.string().min(1).nullish(),
    // O editor do volume ou da coleção (Philip Schaff nos ANF/NPNF, por exemplo): crédito da edição, mostrado à parte.
    editor: z.string().min(1).nullish(),
    traducao_ano: z.number().int().min(1).max(2100).nullish(),
    edicao: z.string().min(1).nullish(),
    traduzida_por_nos: z.boolean().default(false),
    limites_pt: z.string().min(1).nullish(),
    // Pitfall 9: o carregador recusa seção com mais de 80.000 caracteres de texto; a Fonte pode registrar um
    // teto próprio COM o motivo, e a exceção fica à vista no relatório da carga.
    secao_max_caracteres: z
      .object({
        caracteres: z.number().int().min(1),
        motivo: z.string().min(1),
      })
      .strict()
      .nullish(),
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
    // A licença da edição digital nomeia o tradutor e o ano na tela: sem eles o texto jurídico sai pela metade.
    if (f.licenca && licencaCitaATraducao(f.licenca)) {
      if (!f.tradutor)
        ctx.addIssue({
          code: "custom",
          path: ["tradutor"],
          message: "esta licença cita o tradutor: informe `tradutor`",
        });
      if (f.traducao_ano == null)
        ctx.addIssue({
          code: "custom",
          path: ["traducao_ano"],
          message: "esta licença cita o ano da tradução: informe `traducao_ano`",
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

// ───────────────────────── YAML da ficha (rascunho) ─────────────────────────
// Uma ficha só ENTRA como rascunho (D-03, D-17): o contrato não tem campo de verificação, e `estado` só aceita
// 'rascunho'. Quem verifica é um Admin com segundo fator, pelas funções do banco (plano 05), nunca este arquivo.
// Os tetos de citação repetem os do banco (D-19) para o erro vir com o nome do campo antes de abrir conexão.

export const TETO_TRECHO_ORIGINAL = 300;
export const TETO_TEXTO_PT = 2000;

const PAGINA = /^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?$/;
const PAGINA_NUMERICA = /^([0-9]+)(?:-([0-9]+))?$/;

export type PaginaInterpretada = {
  inicio: number | null;
  fim: number | null;
  texto: string | null;
};

/** "39" e "39-53" viram inteiros; qualquer outra forma ("xi-xii", "12a") fica como texto. */
export function interpretarPagina(pagina: string): PaginaInterpretada {
  const m = PAGINA_NUMERICA.exec(pagina);
  if (!m) return { inicio: null, fim: null, texto: pagina };
  const inicio = Number(m[1]);
  return { inicio, fim: m[2] === undefined ? inicio : Number(m[2]), texto: null };
}

// Página escrita sem aspas no YAML ("pagina: 39") chega como número: vira texto antes de validar.
const paginaDoItem = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z
    .string()
    .trim()
    .min(1, "toda página é obrigatória")
    .max(20, "página longa demais")
    .regex(PAGINA, "página inválida (use 39, 39-53 ou xi-xii)"),
);

const esquemaItemFicha = z
  .object({
    tipo: z.enum(["argumento", "trecho"]),
    texto_pt: textoNaoVazio.refine(
      (t) => t.length <= TETO_TEXTO_PT,
      `no máximo ${TETO_TEXTO_PT} caracteres`,
    ),
    pagina: paginaDoItem,
    trecho_original: z
      .string()
      .min(1)
      .max(TETO_TRECHO_ORIGINAL, `no máximo ${TETO_TRECHO_ORIGINAL} caracteres`)
      .nullish(),
    confianca: z.enum(["alta", "media", "baixa"]),
  })
  .strict()
  .superRefine((item, ctx) => {
    const p = interpretarPagina(item.pagina);
    if (p.inicio !== null && p.fim !== null && p.fim < p.inicio)
      ctx.addIssue({ code: "custom", path: ["pagina"], message: "faixa de páginas invertida" });
  });

export const esquemaFichaYaml = z
  .object({
    slug,
    titulo: textoNaoVazio,
    autor: textoNaoVazio,
    ano: z.number().int().min(1).max(2100),
    editora: z.string().min(1).nullish(),
    edicao_consultada: textoNaoVazio,
    estado: z.literal("rascunho", { error: "a ficha só entra como rascunho" }),
    origem_do_rascunho: z.enum(["memoria-do-modelo", "consulta-direta"]),
    idioma_trechos: z.enum(IDIOMAS),
    tese_pt: textoNaoVazio,
    limites_pt: z.string().min(1).nullish(),
    serve_a: z.array(slug).default([]),
    itens: z.array(esquemaItemFicha).min(1, "a ficha precisa de ao menos um item").max(200),
  })
  .strict();
export type FichaYaml = z.infer<typeof esquemaFichaYaml>;

// ───────────────────────── proposta de Grau e de Citação (plano 02-20) ─────────────────────────
// O agente PROPÕE (D-04): nada aqui aprova coisa alguma, e a relação "este trecho sustenta esta frase" é julgamento do
// dono. O contrato só diz a FORMA; o que é conferível por máquina (trecho literal, ficha, item, Passagem) é conferido
// pelo validador (`scripts/acervo/validar-propostas.ts`) e, de novo contra o banco, pela carga. As mensagens de erro
// nomeiam o campo e a regra, nunca a justificativa nem o trecho propostos.

export const GRAUS = ["consenso", "posicao-majoritaria", "disputada"] as const;
export type GrauProposto = (typeof GRAUS)[number];

export const TETO_TRECHO_PARAGRAFO = 600;
export const MINIMO_TRECHO_PARAGRAFO = 12;
export const MINIMO_JUSTIFICATIVA = 40;
export const TETO_JUSTIFICATIVA = 900;
export const PADRAO_ID_DE_AFIRMACAO = /^(bh|pc)[0-9]{2}-a[0-9]+$/;
export const PADRAO_ID_DE_ITEM = /^(argumento|trecho)-[1-9][0-9]*$/;

// A justificativa descreve o MÉTODO e a posição da Fonte, nunca rotula pessoa (lista fechada dos rótulos que o plano nomeia).
const ROTULO_DE_PESSOA = /\b(crentes?|c[eé]ticos?|ateus?|incr[eé]dulos?|descrentes?)\b/iu;

/** Espaço em branco repetido vira um espaço só: a conferência de "cópia literal" ignora quebra de linha e recuo. */
export function normalizarEspaco(texto: string): string {
  return texto.replace(/\s+/gu, " ").trim();
}

const trechoDeParagrafo = z
  .string()
  .refine((t) => normalizarEspaco(t).length >= MINIMO_TRECHO_PARAGRAFO, {
    message: `no mínimo ${MINIMO_TRECHO_PARAGRAFO} caracteres`,
  })
  .refine((t) => normalizarEspaco(t).length <= TETO_TRECHO_PARAGRAFO, {
    message: `no máximo ${TETO_TRECHO_PARAGRAFO} caracteres`,
  });

const esquemaCitacaoDeParagrafo = z
  .object({
    alvo: z.literal("paragrafo"),
    fonte: slug,
    ref: z.string().regex(REF, "referência inválida"),
    trecho: trechoDeParagrafo,
  })
  .strict();

const esquemaCitacaoDeFicha = z
  .object({
    alvo: z.literal("ficha"),
    ficha: slug,
    // O item pelo id estável da ficha sem o slug: `argumento-2`, `trecho-1` (o id completo é `<slug>/<item>`).
    item: z.string().regex(PADRAO_ID_DE_ITEM, "item inválido (use argumento-N ou trecho-N)"),
    pagina: paginaDoItem,
    trecho: z
      .string()
      .min(1)
      .max(TETO_TRECHO_ORIGINAL, `no máximo ${TETO_TRECHO_ORIGINAL} caracteres`)
      .nullish(),
  })
  .strict();

const esquemaCitacaoDePassagem = z
  .object({
    alvo: z.literal("passagem"),
    referencia: z.string().trim().min(3).max(60),
  })
  .strict();

const esquemaCitacaoProposta = z.discriminatedUnion("alvo", [
  esquemaCitacaoDeParagrafo,
  esquemaCitacaoDeFicha,
  esquemaCitacaoDePassagem,
]);
export type CitacaoProposta = z.infer<typeof esquemaCitacaoProposta>;

export const esquemaProposta = z
  .object({
    afirmacao: z.string().regex(PADRAO_ID_DE_AFIRMACAO, "id de Afirmação inválido"),
    // Cópia da frase da Afirmação no momento da proposta: se o Estudo mudar, a proposta deixa de valer (o validador e a carga comparam).
    texto: textoNaoVazio.refine((t) => t.length <= 2000, "no máximo 2000 caracteres"),
    grau_proposto: z.enum(GRAUS),
    justificativa: z
      .string()
      .refine((t) => t.trim().length >= MINIMO_JUSTIFICATIVA, {
        message: `no mínimo ${MINIMO_JUSTIFICATIVA} caracteres`,
      })
      .refine((t) => t.trim().length <= TETO_JUSTIFICATIVA, {
        message: `no máximo ${TETO_JUSTIFICATIVA} caracteres`,
      })
      .refine((t) => !ROTULO_DE_PESSOA.test(t), {
        message: "a justificativa rotula pessoa (descreva o método, não quem pensa)",
      }),
    citacoes: z.array(esquemaCitacaoProposta).max(8).default([]),
    sem_citacao: z.literal(true).optional(),
    motivo: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.sem_citacao) {
      if (p.citacoes.length > 0)
        ctx.addIssue({
          code: "custom",
          path: ["citacoes"],
          message: "com sem_citacao não pode haver Citação",
        });
      if (p.motivo === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["motivo"],
          message: "sem_citacao exige o motivo",
        });
      return;
    }
    if (p.citacoes.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["citacoes"],
        message: "informe ao menos uma Citação ou marque sem_citacao com o motivo",
      });
    if (p.motivo !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["motivo"],
        message: "o motivo só vale com sem_citacao",
      });
  });
export type PropostaYaml = z.infer<typeof esquemaProposta>;

export type ErroDeProposta = {
  /** Posição da entrada na lista do arquivo, a partir de 1. */
  indice: number;
  /** O id da Afirmação quando a entrada o traz legível; senão `null`. */
  afirmacao: string | null;
  mensagem: string;
};

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

/** Lê e valida o YAML de uma ficha em rascunho. O erro nomeia o campo e nunca traz o texto da ficha. */
export function interpretarFichaYaml(conteudo: string, rotulo: string): FichaYaml {
  let bruto: unknown;
  try {
    bruto = lerYaml(conteudo);
  } catch {
    throw new ErroContrato(`YAML ${rotulo} ilegível`);
  }
  const r = esquemaFichaYaml.safeParse(bruto);
  if (!r.success) throw new ErroContrato(`YAML ${rotulo} fora do contrato: ${descrever(r.error)}`);
  return r.data;
}

/**
 * Lê o YAML de propostas (uma lista, uma entrada por Afirmação). NÃO para na primeira entrada ruim: devolve as boas e
 * os erros de cada ruim, para o validador mostrar todas de uma vez. Raiz que não é lista lança (o arquivo inteiro está
 * errado). O erro nomeia o campo e a regra, nunca a justificativa ou o trecho.
 */
export function interpretarPropostasYaml(
  conteudo: string,
  rotulo: string,
): { propostas: PropostaYaml[]; erros: ErroDeProposta[] } {
  let bruto: unknown;
  try {
    bruto = lerYaml(conteudo);
  } catch {
    throw new ErroContrato(`YAML ${rotulo} ilegível`);
  }
  if (!Array.isArray(bruto))
    throw new ErroContrato(
      `YAML ${rotulo} fora do contrato: a raiz deve ser uma lista de propostas`,
    );
  const propostas: PropostaYaml[] = [];
  const erros: ErroDeProposta[] = [];
  for (const [i, entrada] of bruto.entries()) {
    const r = esquemaProposta.safeParse(entrada);
    if (r.success) {
      propostas.push(r.data);
      continue;
    }
    const id = (entrada as { afirmacao?: unknown } | null)?.afirmacao;
    erros.push({
      indice: i + 1,
      afirmacao: typeof id === "string" && PADRAO_ID_DE_AFIRMACAO.test(id) ? id : null,
      mensagem: descrever(r.error),
    });
  }
  return { propostas, erros };
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
