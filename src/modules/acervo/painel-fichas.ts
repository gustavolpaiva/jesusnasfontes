import { z } from "zod";
import { ConteudoMudou, EdicaoNaoConfirmada, FaltamPaginas, SegundoFatorVencido } from "./erros";
import { motivoDasPaginasFaltantes } from "./estado-da-ficha";

// Contrato do painel de fichas (ACER-07, UI-SPEC tela 12): as mensagens do contrato de copy, o formato do que o navegador
// manda às Server Actions (o navegador não é confiável: tudo é validado de novo no servidor) e a tradução dos erros
// tipados da verificação (plano 05) em resultado para a tela. Fica fora do arquivo `"use server"` porque um arquivo de
// Server Actions só exporta ações. NADA do erro original do banco chega ao navegador (T-02-45): sai a mensagem fixa.

/** Texto das mensagens. O `StatusMessage` já abre com a palavra ("Erro.", "Atenção.", "Feito.", "Aviso."); aqui vai o resto. */
export const MENSAGENS_FICHA = {
  rascunho: "Rascunho. Esta ficha não aparece para os Estudantes.",
  segundoFatorVencido:
    "Sua verificação em duas etapas venceu. Confirme de novo para marcar a ficha.",
  confirmarSegundoFator: "Confirmar o segundo fator",
  // Texto novo (plano 02-18): o contrato não previa a recusa de edição não confirmada.
  edicaoNaoConfirmada:
    "A edição consultada desta ficha ainda não foi confirmada. Corrija a edição no arquivo da ficha e recarregue antes de verificar.",
  // Texto novo: a ficha ou o item mudou entre a leitura e o clique (o hash que o Admin viu não é mais o atual).
  conteudoMudou:
    "Esta ficha foi alterada enquanto você a lia. Nada foi marcado. Recarregue a tela para ver o que mudou.",
  itemMudou:
    "Esta página mudou enquanto você a lia. Nada foi marcado. Recarregue a tela para ver o que mudou.",
  servidorConferir: "Não conseguimos registrar a conferência. Nada mudou. Tente de novo.",
  servidorVerificar: "Não conseguimos marcar a ficha como verificada. Nada mudou. Tente de novo.",
  tentarDeNovo: "Tentar de novo",
  recarregar: "Recarregar a tela",
  naFila: "Não conseguimos carregar as fichas. Tente de novo.",
  filaVazia: "Nenhuma ficha à espera",
  filaVaziaDescricao: "Quando uma ficha for carregada como rascunho, ela aparece aqui.",
} as const;

export const mensagemDeVerificada = (data: string) =>
  `Ficha verificada em ${data}. Agora ela aparece no Acervo.`;

export const mensagemDeJaVerificada = (data: string) =>
  `Esta ficha já foi verificada em ${data}, em outra aba. Recarregue a tela.`;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// O hash que o banco calcula é um sha256 em hexadecimal; o servidor não confia no formato: confere só a forma.
const HASH = /^[A-Za-z0-9:_-]{8,200}$/;

export const esquemaConferir = z.object({
  slug: z.string().max(160).regex(SLUG),
  /** `<slug>/<tipo>-<n>`: a identidade estável do item. */
  itemId: z.string().min(3).max(400),
  /** O hash do item que o Admin viu. */
  hash: z.string().regex(HASH),
});

export const esquemaVerificar = z.object({
  slug: z.string().max(160).regex(SLUG),
  fichaId: z.uuid(),
  /** O hash da ficha que o Admin viu. */
  hash: z.string().regex(HASH),
});

export type MotivoDeRecusa =
  | "segundo-fator"
  | "mudou"
  | "faltam"
  | "edicao"
  | "invalido"
  | "servidor";

export type ResultadoDeConferir =
  | { ok: true; itemId: string; novidade: boolean }
  | { ok: false; motivo: MotivoDeRecusa; mensagem: string };

export type ResultadoDeVerificar =
  | { ok: true; verificadaEm: string; novidade: boolean }
  | { ok: false; motivo: MotivoDeRecusa; mensagem: string; faltam?: number };

export type RecusaDaConferencia = Extract<ResultadoDeConferir, { ok: false }>;
export type RecusaDaVerificacao = Extract<ResultadoDeVerificar, { ok: false }>;

/** Erro tipado da conferência → recusa para a tela. `null` se não é um erro conhecido (a ação registra e dá a mensagem geral). */
export function recusaDaConferencia(erro: unknown): RecusaDaConferencia | null {
  if (erro instanceof SegundoFatorVencido)
    return { ok: false, motivo: "segundo-fator", mensagem: MENSAGENS_FICHA.segundoFatorVencido };
  if (erro instanceof ConteudoMudou)
    return { ok: false, motivo: "mudou", mensagem: MENSAGENS_FICHA.itemMudou };
  return null;
}

export function recusaDaVerificacao(erro: unknown): RecusaDaVerificacao | null {
  if (erro instanceof SegundoFatorVencido)
    return { ok: false, motivo: "segundo-fator", mensagem: MENSAGENS_FICHA.segundoFatorVencido };
  if (erro instanceof ConteudoMudou)
    return { ok: false, motivo: "mudou", mensagem: MENSAGENS_FICHA.conteudoMudou };
  if (erro instanceof EdicaoNaoConfirmada)
    return { ok: false, motivo: "edicao", mensagem: MENSAGENS_FICHA.edicaoNaoConfirmada };
  if (erro instanceof FaltamPaginas)
    return {
      ok: false,
      motivo: "faltam",
      faltam: erro.faltam,
      mensagem: motivoDasPaginasFaltantes(erro.faltam),
    };
  return null;
}

/**
 * A ação redirecionou para a tela do segundo fator (`exigirAdmin()` com a sessão sem a marca)? O digest de um
 * redirecionamento do Next é `NEXT_REDIRECT;<tipo>;<destino>;<status>;`.
 */
export function redirecionaParaSegundoFator(erro: unknown, rota: string): boolean {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) return false;
  return digest.split(";")[2] === rota;
}

// Datas do painel: sempre no fuso do centro, para o servidor e o navegador escreverem o mesmo texto.
const FUSO = "America/Sao_Paulo";
const POR_EXTENSO = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: FUSO });
const CURTA = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: FUSO });

/** "24 de novembro de 2026" */
export const dataPorExtenso = (d: Date | string): string => POR_EXTENSO.format(new Date(d));
/** "24/11/2026" */
export const dataCurta = (d: Date | string): string => CURTA.format(new Date(d));
