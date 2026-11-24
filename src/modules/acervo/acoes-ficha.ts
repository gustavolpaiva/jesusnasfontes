"use server";

import { revalidatePath } from "next/cache";
import { registrarErro } from "@/lib/registro";
import { exigirAdmin, ROTA_SEGUNDO_FATOR } from "@/modules/identidade/sessao";
import {
  esquemaConferir,
  esquemaVerificar,
  MENSAGENS_FICHA,
  type ResultadoDeConferir,
  type ResultadoDeVerificar,
  recusaDaConferencia,
  recusaDaVerificacao,
  redirecionaParaSegundoFator,
} from "./painel-fichas";
import { conferirItemUmaVez, verificarFichaUmaVez } from "./verificacao";

// As Server Actions do painel de fichas (ACER-07, D-02, D-03). Cada uma chama a guarda ANTES de qualquer outra coisa
// (uma Server Action é um endereço que qualquer pessoa pode chamar; o layout não roda em toda ação) e escreve só pelas
// funções do banco do plano 05 (`acervo.conferir_item`, `acervo.verificar_ficha`), que reexigem a sessão de um Admin com
// segundo fator DE NOVO: a guarda daqui e a do banco são independentes (T-02-48). O hash do item e o da ficha são os que
// o navegador LEU; o banco os confere com a linha travada e recusa o velho (T-02-46, 40001). O que volta ao navegador é a
// mensagem fixa do contrato, nunca texto do banco. Helpers e esquemas ficam fora deste arquivo: um arquivo de Server
// Actions só exporta ações.

const FILA = "/admin/acervo/fichas";

type Guarda = { ok: true; sessaoId: string } | { ok: false };

/**
 * `exigirAdmin()` é a primeira coisa de toda ação (por esta função). Não-Admin cai na 404 e quem não tem sessão vai à
 * entrada, como em toda a administração. O Admin cuja sessão perdeu o segundo fator NÃO é redirecionado em silêncio:
 * aqui a ação devolve a mensagem do contrato com a ação de confirmar (UI-SPEC tela 12), e nenhum estado muda.
 */
async function guardar(): Promise<Guarda> {
  try {
    const sessao = await exigirAdmin();
    return { ok: true, sessaoId: sessao.sessao.id };
  } catch (erro) {
    if (redirecionaParaSegundoFator(erro, ROTA_SEGUNDO_FATOR)) return { ok: false };
    throw erro;
  }
}

/** O Admin conferiu esta página no livro, para o hash do item que ele viu. Sem desfazer (UI-SPEC). */
export async function conferirItemAction(dados: unknown): Promise<ResultadoDeConferir> {
  const guarda = await guardar();
  if (!guarda.ok)
    return { ok: false, motivo: "segundo-fator", mensagem: MENSAGENS_FICHA.segundoFatorVencido };
  const lido = esquemaConferir.safeParse(dados);
  if (!lido.success || !lido.data.itemId.startsWith(`${lido.data.slug}/`))
    return { ok: false, motivo: "invalido", mensagem: MENSAGENS_FICHA.servidorConferir };
  const { slug, itemId, hash } = lido.data;
  try {
    const gravou = await conferirItemUmaVez(guarda.sessaoId, itemId, hash);
    revalidatePath(`${FILA}/${slug}`);
    revalidatePath(FILA);
    return { ok: true, itemId, novidade: gravou };
  } catch (erro) {
    const recusa = recusaDaConferencia(erro);
    if (recusa) return recusa;
    registrarErro("acervo-conferir-item", erro);
    return { ok: false, motivo: "servidor", mensagem: MENSAGENS_FICHA.servidorConferir };
  }
}

/** O Admin marcou a ficha como verificada, para o hash da ficha que ele viu. O banco decide; esta ação só traduz. */
export async function verificarFichaAction(dados: unknown): Promise<ResultadoDeVerificar> {
  const guarda = await guardar();
  if (!guarda.ok)
    return { ok: false, motivo: "segundo-fator", mensagem: MENSAGENS_FICHA.segundoFatorVencido };
  const lido = esquemaVerificar.safeParse(dados);
  if (!lido.success)
    return { ok: false, motivo: "invalido", mensagem: MENSAGENS_FICHA.servidorVerificar };
  const { slug, fichaId, hash } = lido.data;
  try {
    const r = await verificarFichaUmaVez(guarda.sessaoId, fichaId, hash);
    revalidatePath(`${FILA}/${slug}`);
    revalidatePath(FILA);
    // O Acervo do Estudante também muda: a ficha passa a aparecer (ou, já verificada, continua).
    revalidatePath("/acervo");
    revalidatePath(`/acervo/${slug}`);
    return { ok: true, verificadaEm: r.verificadaEm.toISOString(), novidade: r.gravou };
  } catch (erro) {
    const recusa = recusaDaVerificacao(erro);
    if (recusa) return recusa;
    registrarErro("acervo-verificar-ficha", erro);
    return { ok: false, motivo: "servidor", mensagem: MENSAGENS_FICHA.servidorVerificar };
  }
}
