import { ErroDeBanco } from "@/db/erro-banco";
import { MENSAGENS_GRAUS, type RecusaDaAprovacao } from "./painel-graus";

// Só no servidor: `ErroDeBanco` puxa o `pg`, que nunca pode ir para o pacote do navegador (o contrato do painel,
// `painel-graus.ts`, é importado pelo componente de cliente).

/**
 * SQLSTATE de `acervo.aprovar_afirmacao` (migração 0028) → recusa para a tela. `null` se não é um erro conhecido (a ação
 * registra e dá a mensagem geral). 22023 (grau fora da lista) e 0A000 (fora de READ COMMITTED) não são caso do usuário.
 */
export function recusaDaAprovacao(
  erro: unknown,
  afirmacaoId: string | null,
): RecusaDaAprovacao | null {
  if (!(erro instanceof ErroDeBanco)) return null;
  switch (erro.code) {
    case "42501":
      return {
        ok: false,
        afirmacaoId,
        motivo: "segundo-fator",
        mensagem: MENSAGENS_GRAUS.segundoFatorVencido,
      };
    case "40001":
      return { ok: false, afirmacaoId, motivo: "mudou", mensagem: MENSAGENS_GRAUS.textoMudou };
    case "P0003":
      return {
        ok: false,
        afirmacaoId,
        motivo: "nao-sustentada",
        mensagem: MENSAGENS_GRAUS.naoSustentada,
      };
    case "P0002":
      return {
        ok: false,
        afirmacaoId,
        motivo: "sem-citacao",
        mensagem: MENSAGENS_GRAUS.semCitacao,
      };
    default:
      return null;
  }
}
