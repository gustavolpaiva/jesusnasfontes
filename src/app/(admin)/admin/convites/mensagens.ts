import type { TipoDeMensagem } from "@/components/estado/status-message";
import type { ResultadoDeAcao } from "@/modules/convites/acoes";

// Texto de cada resultado das ações de convite. O contrato de copy traz os de convidar, reenviar e
// revogar; os demais (recusas que ele não prevê) estão listados no resumo do plano 01-15 para o dono.
export type Mensagem = { tipo: TipoDeMensagem; texto: string };

export const SEM_CONEXAO: Mensagem = {
  tipo: "erro",
  texto: "Sem conexão. Tente de novo quando a conexão voltar.",
};

const FALHA: Mensagem = { tipo: "erro", texto: "Não conseguimos concluir agora. Tente de novo." };

// A chamada da ação nem chegou, ou o servidor respondeu com falha de transporte (503). Devolve a mensagem a mostrar, ou
// `null` quando o erro é um sinal de navegação do Next (redirecionamento, não encontrado), que precisa subir. Antes, só "sem conexão" era tratada e todo o resto escapava do tratador assíncrono sem mensagem alguma.
// Redirecionamento e "não encontrado" do Next trazem um digest com esses prefixos. Em produção o React põe digest em
// QUALQUER erro de servidor, então a presença do campo não distingue: só o valor.
function ehSinalDeNavegacao(erro: unknown): boolean {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") ||
      digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
      digest === "NEXT_NOT_FOUND")
  );
}

export function mensagemDaFalha(erro: unknown, online: boolean): Mensagem | null {
  if (!online) return SEM_CONEXAO;
  if (ehSinalDeNavegacao(erro)) return null;
  return FALHA;
}

const NAO_SAIU =
  "O convite foi registrado, mas o e-mail não saiu. Use Reenviar daqui a alguns minutos.";

export function mensagemDe(r: ResultadoDeAcao): Mensagem {
  if (r.ok) {
    if (r.tipo === "convidado") {
      return r.emailSaiu
        ? { tipo: "sucesso", texto: `Convite registrado e enviado para ${r.email}.` }
        : { tipo: "aviso", texto: NAO_SAIU };
    }
    if (r.tipo === "reenviado") {
      return r.emailSaiu
        ? { tipo: "sucesso", texto: `Convite reenviado para ${r.email}.` }
        : { tipo: "aviso", texto: "O e-mail não saiu. Use Reenviar daqui a alguns minutos." };
    }
    return { tipo: "sucesso", texto: "Convite revogado." };
  }
  switch (r.erro) {
    case "malformado":
      return { tipo: "erro", texto: "Esse e-mail parece incompleto. Confira e tente de novo." };
    case "duplicado":
      return { tipo: "erro", texto: "Este e-mail já tem convite. Use Reenviar na lista." };
    case "limite":
      return {
        tipo: "erro",
        texto:
          "Você já reenviou este convite três vezes na última hora. Espere um pouco e tente de novo.",
      };
    case "proprio":
      return { tipo: "erro", texto: "Você não pode revogar o seu próprio convite." };
    case "unico-admin":
      return {
        tipo: "erro",
        texto: "Este é o único Admin do grupo. O convite dele não pode ser revogado.",
      };
    case "inexistente":
    case "estado":
      return {
        tipo: "erro",
        texto: "Este convite mudou e não aceita mais esta ação. A lista foi atualizada.",
      };
    default:
      return FALHA;
  }
}
