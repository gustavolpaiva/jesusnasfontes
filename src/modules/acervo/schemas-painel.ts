import { z } from "zod";
import { licencaValida } from "./licenca-exibida";
import { IDIOMAS, NIVEIS } from "./schemas";

// Contrato do formulário de Fonte do painel do Admin (ACER-08, UI-SPEC tela 11). Vale no navegador (para o formulário
// montar o estado) e no servidor (a Server Action valida de novo: o navegador não é confiável). A regra de ACER-09 NÃO
// mora aqui: é do banco (restrições de linha e gatilhos), e o formulário só traduz a recusa. Este arquivo valida forma
// (https, tamanho, vocabulário), nunca a regra de negócio.

/** Texto das mensagens do contrato de copy. O componente `StatusMessage` já abre com a palavra "Erro."; aqui vai o resto. */
export const MENSAGENS = {
  obraProtegida:
    "Obra protegida não pode ter texto integral. Guarde só a ficha, com trechos curtos de até 300 caracteres.",
  licenca: "Texto integral precisa de licença e de endereço https da origem.",
  https: "O endereço precisa começar com https://.",
  servidor: "Não conseguimos salvar a Fonte. O que você digitou continua aqui. Tente de novo.",
  salva: "Fonte salva.",
  titulo: "Informe o título da Fonte.",
  tradicao: "Leitura confessional exige a tradição.",
  licencaForaDaLista:
    "Esta licença não está na lista de códigos. Use um dos códigos mostrados abaixo do campo.",
  ano: "Use só números, como 1737.",
  texto: "O texto de cada seção precisa de ao menos um parágrafo.",
  paragrafoCitado:
    "Um parágrafo que perderia o texto já tem Citação num Estudo. Mantenha o número de parágrafos e corrija o texto.",
  doArquivo: "Este campo vem do arquivo versionado e não se edita aqui.",
  revisao:
    "Esta Fonte foi alterada por outra pessoa, ou por uma carga do arquivo, enquanto você editava. Nada foi salvo. Recarregue a página para ver o que mudou; o que você digitou continua aqui até recarregar.",
} as const;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HTTPS = /^https:\/\/\S+$/;

/** O endereço do formulário nunca vira requisição do servidor (T-02-44): só texto e link. */
const enderecoOpcional = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === "" || HTTPS.test(v), MENSAGENS.https);
const textoOpcional = (max: number) => z.string().trim().max(max, `No máximo ${max} caracteres.`);

const esquemaSecaoFormulario = z
  .object({
    /** Id do cliente: o servidor o devolve com o endereço dado, e o formulário casa a resposta por ele, nunca pela posição. */
    cid: z.string().min(1).max(64),
    /** A chave da seção, dada pelo servidor; ausente na seção nova. O endereço é só exibição e nem viaja. */
    id: z.string().min(1).max(300).optional(),
    /** A versão da seção que o formulário viu (uuid); obrigatória quando há `id` (o banco recusa a velha). */
    versao: z.uuid().optional(),
    titulo: z
      .string()
      .trim()
      .min(1, "Informe o título da seção.")
      .max(300, "No máximo 300 caracteres."),
    texto: z
      .string()
      .max(80_000, "A seção passa de 80.000 caracteres. Divida em duas seções.")
      .refine((t) => t.trim().length > 0, MENSAGENS.texto),
    resumo_pt: textoOpcional(2000),
    palavras_chave_pt: z.string().max(2000),
  })
  .strict()
  .refine((s) => (s.id === undefined) === (s.versao === undefined), {
    message: MENSAGENS.servidor,
    path: ["versao"],
  });

export const esquemaFonteFormulario = z
  .object({
    modo: z.enum(["criar", "editar"]),
    /** Só na edição; na criação o servidor o deriva do título. */
    slug: z.string().regex(SLUG).optional(),
    titulo: z.string().trim().min(1, MENSAGENS.titulo).max(300, "No máximo 300 caracteres."),
    autor: textoOpcional(200),
    epoca: textoOpcional(120),
    nivel: z.enum(NIVEIS),
    tradicao: textoOpcional(120),
    idioma: z.enum(IDIOMAS),
    tipo_texto: z.enum(["integral", "ficha"]),
    obra_protegida: z.boolean(),
    origem_nome: textoOpcional(200),
    origem_url: enderecoOpcional,
    licenca: z
      .string()
      .trim()
      .max(80)
      .refine((v) => v === "" || licencaValida(v), MENSAGENS.licencaForaDaLista),
    licenca_url: enderecoOpcional,
    tradutor: textoOpcional(200),
    traducao_ano: z
      .string()
      .trim()
      .regex(/^(\d{1,4})?$/, MENSAGENS.ano),
    edicao: textoOpcional(300),
    traduzida_por_nos: z.boolean(),
    limites_pt: textoOpcional(5000),
    publicada: z.boolean(),
    /** A revisão que o formulário leu ao abrir; obrigatória na edição (o banco recusa a velha). */
    revisao: z.number().int().min(0).max(2_000_000_000).optional(),
    secoes: z.array(esquemaSecaoFormulario).max(60).default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.modo === "editar" && !f.slug)
      ctx.addIssue({ code: "custom", path: ["slug"], message: "Fonte sem endereço." });
    if (f.modo === "editar" && f.revisao === undefined)
      ctx.addIssue({ code: "custom", path: ["revisao"], message: MENSAGENS.servidor });
    // Só a exigência de FORMA do Nível: a regra de ACER-09 e a de licença são do banco.
    if (f.nivel === "confessional" && f.tradicao === "")
      ctx.addIssue({ code: "custom", path: ["tradicao"], message: MENSAGENS.tradicao });
  });
export type FormularioDeFonte = z.input<typeof esquemaFonteFormulario>;

/** O que o painel edita numa Fonte que veio do arquivo: os limites e a publicação. */
export const esquemaFonteDoArquivo = z
  .object({
    slug: z.string().regex(SLUG),
    revisao: z.number().int().min(0).max(2_000_000_000),
    limites_pt: textoOpcional(5000),
    publicada: z.boolean(),
  })
  .strict();

export const esquemaResumoDeSecao = z
  .object({
    slug: z.string().regex(SLUG),
    secao: z.string().regex(SLUG),
    revisao: z.number().int().min(0).max(2_000_000_000),
    resumo_pt: textoOpcional(2000),
    palavras_chave_pt: z.string().max(2000),
  })
  .strict();

/** Resultado de toda ação de salvar: erros por campo (id do campo → mensagem) ou o endereço da Fonte. */
export type ResultadoDeSalvar =
  | {
      ok: true;
      slug: string;
      /** A revisão depois de salvar: o formulário passa a mandar esta. */
      revisao: number;
      /** Por seção enviada: o `cid` que o servidor recebeu, o id dado e a versão depois de salvar. */
      secoes: { cid: string; id: string; versao: string }[];
    }
  | { ok: false; erros: Record<string, string>; geral?: string };

/** O id do campo no formulário a partir do caminho do erro do zod: `secoes.0.titulo` vira `secoes-0-titulo`. */
export function idDoCampo(caminho: readonly PropertyKey[]): string {
  return caminho.map(String).join("-");
}

/** Um erro por campo, o primeiro de cada um. */
export function errosPorCampo(erro: z.ZodError): Record<string, string> {
  const r: Record<string, string> = {};
  for (const i of erro.issues) {
    const id = idDoCampo(i.path.length > 0 ? i.path : ["geral"]);
    if (!(id in r)) r[id] = i.message;
  }
  return r;
}

/** "Obra Antiga, Parte 1" vira "obra-antiga-parte-1": o endereço da Fonte criada pelo painel. */
export function slugDoTitulo(titulo: string): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base === "" ? "fonte" : base;
}

/** Palavras-chave digitadas ("a, b\nc") em lista sem vazios nem repetidas. */
export function listaDePalavras(texto: string): string[] {
  const vistas = new Set<string>();
  for (const p of texto.split(/[,\n]/)) {
    const limpa = p.trim();
    if (limpa !== "") vistas.add(limpa);
  }
  return [...vistas];
}

/** Nome legível de um campo em conflito (`limites_pt`, `18:resumo_pt`), para o aviso e o diálogo. */
export function rotuloDoCampoEmConflito(campo: string): string {
  if (campo === "limites_pt") return "O que esta Fonte não pode dizer";
  const [secao, nome] = campo.split(":");
  if (nome === "resumo_pt") return `Resumo em português (seção ${secao})`;
  if (nome === "palavras_chave_pt") return `Palavras-chave em português (seção ${secao})`;
  return campo;
}

export function listaEmTexto(itens: readonly string[]): string {
  if (itens.length <= 1) return itens.join("");
  return `${itens.slice(0, -1).join(", ")} e ${itens.at(-1)}`;
}
