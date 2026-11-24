"use server";

import { revalidatePath } from "next/cache";
import { registrarErro } from "@/lib/registro";
import { exigirAdmin, ROTA_SEGUNDO_FATOR } from "@/modules/identidade/sessao";
import { aprovarAfirmacao } from "./aprovacao";
import type { GrauDeCerteza } from "./estado-da-proposta";
import { redirecionaParaSegundoFator } from "./painel-fichas";
import { esquemaAprovar, MENSAGENS_GRAUS, type ResultadoDeAprovar } from "./painel-graus";
import { recusaDaAprovacao } from "./recusa-da-aprovacao";

// A Server Action do painel de graus propostos (ACER-06, ACER-10, D-04). `exigirAdmin()` é a primeira coisa (uma Server
// Action é um endereço que qualquer pessoa pode chamar; o layout não roda em toda ação), e a escrita sai só por
// `acervo.aprovar_afirmacao`, que reexige a sessão de um Admin com segundo fator DE NOVO: as duas guardas são independentes
// (T-02-57). Os dois hashes são os que o navegador LEU: o banco os confere com a Afirmação travada e recusa o velho
// (T-02-58, 40001). O que volta ao navegador é a frase fixa do contrato, nunca texto do banco nem texto livre. Não há
// ação de rejeitar nem de aprovar em lote (D-04): cada Grau é uma decisão de julgamento do dono.

const LISTA = "/admin/acervo/graus";

type Guarda = { ok: true; sessaoId: string } | { ok: false };

async function guardar(): Promise<Guarda> {
  try {
    const sessao = await exigirAdmin();
    return { ok: true, sessaoId: sessao.sessao.id };
  } catch (erro) {
    if (redirecionaParaSegundoFator(erro, ROTA_SEGUNDO_FATOR)) return { ok: false };
    throw erro;
  }
}

/** O dono aprova (ou corrige) o Grau desta Afirmação, para o texto e as Citações que ele viu. */
export async function aprovarGrauAction(dados: unknown): Promise<ResultadoDeAprovar> {
  const guarda = await guardar();
  const idLido = esquemaAprovar.safeParse(dados);
  const afirmacaoId = idLido.success ? idLido.data.afirmacaoId : null;
  if (!guarda.ok)
    return {
      ok: false,
      afirmacaoId,
      motivo: "segundo-fator",
      mensagem: MENSAGENS_GRAUS.segundoFatorVencido,
    };
  if (!idLido.success)
    return { ok: false, afirmacaoId, motivo: "invalido", mensagem: MENSAGENS_GRAUS.servidor };
  const { textoHash, citacoesHash } = idLido.data;
  const grau = idLido.data.grau as GrauDeCerteza;
  try {
    await aprovarAfirmacao(guarda.sessaoId, idLido.data.afirmacaoId, textoHash, grau, citacoesHash);
    revalidatePath(LISTA);
    revalidatePath("/admin");
    // O Estudo do Estudante também muda: a frase passa a mostrar a Citação.
    revalidatePath("/estudos/[slug]", "page");
    return { ok: true, afirmacaoId: idLido.data.afirmacaoId, grau };
  } catch (erro) {
    const recusa = recusaDaAprovacao(erro, idLido.data.afirmacaoId);
    if (recusa) return recusa;
    registrarErro("acervo-aprovar-grau", erro);
    return {
      ok: false,
      afirmacaoId: idLido.data.afirmacaoId,
      motivo: "servidor",
      mensagem: MENSAGENS_GRAUS.servidor,
    };
  }
}
