import { z } from "zod";
import { ehGrau, type GrauDeCerteza, MOTIVO_DO_TEXTO_MUDOU } from "./estado-da-proposta";

// (A tradução do SQLSTATE fica em `recusa-da-aprovacao.ts`: este arquivo vai ao navegador, e o erro de banco puxa o `pg`.)
// Contrato do painel de graus propostos (ACER-06, ACER-10, UI-SPEC tela 13): as mensagens do contrato de copy, o formato do
// que o navegador manda à Server Action (o navegador não é confiável: tudo é validado de novo no servidor) e a tradução da
// recusa do banco em resultado para a tela. Fica fora do arquivo `"use server"` porque um arquivo de Server Actions só
// exporta ações. NADA do erro original do banco chega ao navegador, e nenhuma mensagem repete texto livre (a frase, a
// justificativa, o trecho): sai só a frase fixa.

export const MENSAGENS_GRAUS = {
  titulo: "Graus propostos",
  lede: "O agente propõe o Grau de certeza de cada Afirmação, com a Fonte ou a ficha que o justifica. Só o grau que você aprova aparece na tela.",
  vazio: "Nenhuma proposta pendente",
  vazioDescricao: "As propostas aparecem aqui quando o arquivo de graus for carregado.",
  vazioAprovadas: "Nenhuma proposta aprovada",
  vazioAprovadasDescricao: "As que você aprovar aparecem aqui.",
  erroDeCarga: "Não conseguimos carregar as propostas. Tente de novo.",
  tentarDeNovo: "Tentar de novo",
  recarregar: "Recarregar as propostas",
  maisPropostas: "Mostrar mais propostas",
  verNoEstudo: "Ver no Estudo",
  aprovar: "Aprovar este grau",
  aprovando: "Aprovando…",
  textoMudou: MOTIVO_DO_TEXTO_MUDOU,
  // Texto novo (plano 02-21): o contrato manda "a mesma saída" do segundo fator, mas a frase da ficha diria "marcar a ficha".
  segundoFatorVencido:
    "Sua verificação em duas etapas venceu. Confirme de novo para aprovar o grau.",
  confirmarSegundoFator: "Confirmar o segundo fator",
  // Texto novo: o alvo de uma Citação deixou de sustentá-la entre a leitura e o clique (ficha ou Fonte).
  naoSustentada: "Alguma Citação perdeu o que a sustenta. Recarregue as propostas.",
  // Texto novo: a Afirmação não tem mais Citação proposta.
  semCitacao: "Esta frase ficou sem Citação proposta. Recarregue as propostas.",
  // Texto novo: falha que não é nenhuma das conhecidas.
  servidor: "Não conseguimos aprovar o grau. Nada mudou. Tente de novo.",
} as const;

export const mensagemDeSucesso = (rotuloDoGrau: string) =>
  `Grau aprovado: ${rotuloDoGrau}. A frase passa a mostrar a Citação no Estudo.`;

export const textoDaMeta = (n: number, total: number) =>
  `${n} de ${total} Afirmações com Citação aprovada`;

const ID_DE_AFIRMACAO = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HASH_HEX = /^[0-9a-f]{64}$/;

/** O que o navegador manda: o id da Afirmação, os dois hashes que a tela LEU e o Grau escolhido. */
export const esquemaAprovar = z.object({
  afirmacaoId: z.string().min(1).max(80).regex(ID_DE_AFIRMACAO),
  textoHash: z.string().regex(HASH_HEX),
  citacoesHash: z.string().regex(HASH_HEX),
  grau: z.string().refine(ehGrau),
});

export type MotivoDaRecusaDoGrau =
  | "segundo-fator"
  | "mudou"
  | "nao-sustentada"
  | "sem-citacao"
  | "invalido"
  | "servidor";

export type ResultadoDeAprovar =
  | { ok: true; afirmacaoId: string; grau: GrauDeCerteza }
  | { ok: false; afirmacaoId: string | null; motivo: MotivoDaRecusaDoGrau; mensagem: string };

export type RecusaDaAprovacao = Extract<ResultadoDeAprovar, { ok: false }>;

/** Quantas propostas entram por vez em `?ate=` (e quanto cada "Mostrar mais" acrescenta). */
export const POR_VEZ = 20;

// `?ate=` NÃO tem teto: o endereço é entrada não confiável, mas o formato já limita o pedido (só dígitos, até 6), e a
// leitura devolve no máximo as propostas que EXISTEM. Recusar acima de um teto com o padrão de 20 encolheria a lista em
// silêncio (o achado da revisão: `ate=420` virava 20 e as propostas além de 400 ficavam inacessíveis). O que não é um
// múltiplo de 20 a partir de 20 vale o padrão — o link de "Mostrar mais" só existe enquanto há restantes, então o valor
// que ele gera cresce de 20 em 20 até o fim da lista, nunca além.
/** `?ate=` do endereço: um múltiplo de 20 a partir de 20, sem teto; qualquer outra coisa vale 20. */
export function lerLimite(valor: unknown): number {
  const v = Array.isArray(valor) ? valor[0] : valor;
  if (typeof v !== "string" || !/^[0-9]{1,6}$/.test(v)) return POR_VEZ;
  const n = Number(v);
  if (!Number.isInteger(n) || n < POR_VEZ || n % POR_VEZ !== 0) return POR_VEZ;
  return n;
}
