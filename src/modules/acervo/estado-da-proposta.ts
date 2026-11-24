// Os quatro estados de uma proposta de Grau no painel do Admin (ACER-06, ACER-10, D-04, UI-SPEC tela 13). São DERIVADOS
// no servidor, nunca gravados: o que existe no banco é a proposta (com o hash do texto de quando foi feita), a
// Afirmação (com o hash atual), a aprovação do dono (com os dois hashes que ela viu) e o estado vivo dos alvos das
// Citações. Função pura: sem banco, sem relógio, testável. A regra de "vale" é a do banco (`acervo.aprovacao_vale`); esta
// função só a repete em cima dos mesmos fatos, e o teste de integração prova que as duas concordam.

export type GrauDeCerteza = "consenso" | "posicao-majoritaria" | "disputada";

export const GRAUS: readonly GrauDeCerteza[] = ["consenso", "posicao-majoritaria", "disputada"];

export function ehGrau(valor: unknown): valor is GrauDeCerteza {
  return typeof valor === "string" && (GRAUS as readonly string[]).includes(valor);
}

export type EstadoDaProposta = "pendente" | "aprovada" | "aguardando-ficha" | "texto-mudou";

export type EntradaDoEstadoDaProposta = {
  /** O hash do texto da Afirmação de quando o agente fez a proposta. */
  propostaTextoHash: string;
  /** O hash ATUAL do texto da Afirmação. */
  afirmacaoTextoHash: string;
  /** A aprovação gravada (os hashes que o dono viu), ou `null` se nunca aprovou. */
  aprovacao: { textoHash: string; citacoesHash: string } | null;
  /** O hash ATUAL do conjunto de Citações, calculado pelo banco. */
  citacoesHash: string;
  /** Quantas fichas citadas ainda não estão verificadas para o hash atual delas. */
  fichasNaoVerificadas: number;
  /** Todos os alvos sustentam a Citação (ficha verificada, Fonte publicada), pela regra do banco. */
  alvosSustentam: boolean;
};

/**
 * - texto-mudou: a frase mudou depois da proposta. Vence tudo, porque a proposta foi feita sobre outra frase e nada
 *   dela se aplica mais (nem uma aprovação antiga: o banco a esconde pelo mesmo motivo);
 * - aguardando-ficha: alguma Citação depende de ficha ainda não verificada (a Citação não vale);
 * - aprovada: há aprovação com o texto atual e o conjunto atual de Citações, e os alvos sustentam;
 * - pendente: o resto (inclusive aprovação velha, de Citações que mudaram depois).
 */
export function estadoDaProposta(e: EntradaDoEstadoDaProposta): EstadoDaProposta {
  if (e.propostaTextoHash !== e.afirmacaoTextoHash) return "texto-mudou";
  if (e.fichasNaoVerificadas > 0) return "aguardando-ficha";
  const a = e.aprovacao;
  if (
    a !== null &&
    a.textoHash === e.afirmacaoTextoHash &&
    a.citacoesHash === e.citacoesHash &&
    e.alvosSustentam
  )
    return "aprovada";
  return "pendente";
}

export type FiltroDeGraus = "pendentes" | "aprovadas" | "todas";

export const FILTROS: readonly FiltroDeGraus[] = ["pendentes", "aprovadas", "todas"];

export function lerFiltro(valor: unknown): FiltroDeGraus {
  const v = Array.isArray(valor) ? valor[0] : valor;
  return FILTROS.find((f) => f === v) ?? "pendentes";
}

/** Pendentes é tudo o que ainda não está aprovado (inclusive o que espera ficha e o que teve o texto mudado). */
export function estaNoFiltro(estado: EstadoDaProposta, filtro: FiltroDeGraus): boolean {
  if (filtro === "todas") return true;
  return filtro === "aprovadas" ? estado === "aprovada" : estado !== "aprovada";
}

export type ContagemDosFiltros = Record<FiltroDeGraus, number>;

export function contarFiltros(estados: readonly EstadoDaProposta[]): ContagemDosFiltros {
  const aprovadas = estados.filter((s) => s === "aprovada").length;
  return { pendentes: estados.length - aprovadas, aprovadas, todas: estados.length };
}

export const ROTULO_DO_ESTADO: Record<EstadoDaProposta, string> = {
  pendente: "Pendente",
  aprovada: "Aprovada",
  "aguardando-ficha": "Aguardando ficha",
  "texto-mudou": "Texto mudou",
};

export const MOTIVO_DO_TEXTO_MUDOU =
  "Esta frase mudou depois da proposta. Recarregue as propostas.";

export function motivoDaFichaFaltando(obras: readonly string[]): string {
  return `Falta verificar a ficha de ${listarObras(obras)}.`;
}

export function motivoDaFonteFaltando(obras: readonly string[]): string {
  return obras.length === 1
    ? `Falta publicar a Fonte ${obras[0]}.`
    : `Falta publicar as Fontes ${listarObras(obras)}.`;
}

function listarObras(obras: readonly string[]): string {
  if (obras.length <= 1) return obras[0] ?? "";
  return `${obras.slice(0, -1).join(", ")} e ${obras[obras.length - 1]}`;
}

/**
 * O motivo, em texto, de o botão de aprovar não ter efeito; `null` quando pode aprovar. O texto mudado vence (é o que o
 * contrato diz), depois a ficha, depois a Fonte não publicada.
 */
export function motivoDoBotao(entrada: {
  estado: EstadoDaProposta;
  fichasFaltando: readonly string[];
  fontesFaltando: readonly string[];
}): string | null {
  if (entrada.estado === "texto-mudou") return MOTIVO_DO_TEXTO_MUDOU;
  if (entrada.fichasFaltando.length > 0) return motivoDaFichaFaltando(entrada.fichasFaltando);
  if (entrada.fontesFaltando.length > 0) return motivoDaFonteFaltando(entrada.fontesFaltando);
  return null;
}

/** "Aprovar este grau" enquanto o valor escolhido é o proposto; "Aprovar o grau corrigido" quando o dono mudou o valor. */
export function rotuloDoBotao(escolhido: GrauDeCerteza, proposto: GrauDeCerteza): string {
  return escolhido === proposto ? "Aprovar este grau" : "Aprovar o grau corrigido";
}
