import "server-only";
import type { obterAuth } from "@/lib/auth";
import {
  concederSegundoFator,
  desfazerAtivacao,
  reivindicarCodigoDeAplicativo,
} from "./sessao-mfa";

// O miolo da conferência do segundo fator, separado da Server Action para poder ser exercitado com
// falha de banco forçada em cada passo. Ordem, e por quê:
//   1. cadastro pendente: os códigos de recuperação são LIDOS antes de qualquer escrita que ative o
//      fator ou marque a sessão. Se a leitura falhar, nada foi ativado e a pessoa repete do começo;
//   2. a biblioteca confere (e, no cadastro pendente, ativa);
//   3. a concessão (compare-and-set da geração) marca a sessão;
//   4. só então os códigos já lidos são devolvidos. Os códigos vivem só nesta variável local: nunca
//      em registro, erro, URL, cookie ou estado do servidor.
// Falha de banco depois de a biblioteca ativar e antes da concessão desfaz a ativação (por id da
// conta), para a pessoa nunca sair com o fator ativo e sem os códigos na mão.

type Api = ReturnType<typeof obterAuth>["api"];
export type ApiDaConferencia = Pick<Api, "verifyTOTP" | "verifyBackupCode" | "viewBackupCodes">;

export type ResultadoDaConferencia =
  | { tipo: "recusado" }
  | { tipo: "perdida"; sessaoId: string }
  | { tipo: "concedido"; codigos?: string[] };

export async function conferirCodigo(p: {
  api: ApiDaConferencia;
  alvo: "aplicativo" | "recuperacao";
  codigo: string;
  usuarioId: string;
  sessaoAtualId: string;
  geracao: number;
  estado: "pendente" | "ativo";
  cabecalhos: Headers;
  sessaoQueVale: (idAntes: string) => Promise<string>;
  conceder?: typeof concederSegundoFator;
}): Promise<ResultadoDaConferencia> {
  const conceder = p.conceder ?? concederSegundoFator;
  let codigos: string[] | undefined;
  if (p.estado === "pendente") {
    const lido = (await p.api.viewBackupCodes({ body: { userId: p.usuarioId } })) as {
      backupCodes: string[];
    };
    codigos = lido.backupCodes;
  }
  try {
    if (p.alvo === "aplicativo") {
      await p.api.verifyTOTP({ body: { code: p.codigo }, headers: p.cabecalhos });
    } else {
      await p.api.verifyBackupCode({
        body: { code: p.codigo, disableSession: true },
        headers: p.cabecalhos,
      });
    }
  } catch (erro) {
    // Código recusado, ou corrida perdida no código de recuperação (a biblioteca troca o conjunto
    // de códigos de forma condicional e a perdedora recebe conflito): as duas gastam a tentativa.
    if (erro instanceof Error && erro.name === "APIError") return { tipo: "recusado" };
    throw erro;
  }
  let concedido = false;
  try {
    if (p.alvo === "aplicativo" && !(await reivindicarCodigoDeAplicativo(p.usuarioId, p.codigo))) {
      return { tipo: "recusado" };
    }
    const idValido = await p.sessaoQueVale(p.sessaoAtualId);
    if (!(await conceder(p.usuarioId, idValido, p.geracao))) {
      return { tipo: "perdida", sessaoId: idValido };
    }
    concedido = true;
    return { tipo: "concedido", codigos };
  } catch (erro) {
    if (p.estado === "pendente" && !concedido) {
      try {
        await desfazerAtivacao(p.usuarioId);
      } catch {
        // Banco indisponível também para desfazer: o estado fica como está (a pessoa ainda entra com
        // o aplicativo); o erro original é o que sobe.
      }
    }
    throw erro;
  }
}
