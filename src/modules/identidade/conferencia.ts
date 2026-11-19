import "server-only";
import type { obterAuth } from "@/lib/auth";
import {
  concederSegundoFator,
  desfazerAtivacao,
  liberarCodigoDeAplicativo,
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
// O código de aplicativo é reivindicado (marca atômica) ANTES de a biblioteca escrever. Toda saída
// que não seja "concedido" (recusa, perda para a recuperação, falha de banco) passa por um único
// bloco de compensação: o cadastro pendente volta a pendente (por id da conta) e a reivindicação é
// liberada, para repetir o mesmo código funcionar. Código que concedeu continua marcado e recusado.

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
  // O código de aplicativo é reivindicado ANTES de a biblioteca escrever qualquer coisa: se a
  // reivindicação falha (código já usado), a biblioteca nem é chamada e nada muda.
  const reivindicou = p.alvo === "aplicativo";
  if (reivindicou && !(await reivindicarCodigoDeAplicativo(p.usuarioId, p.codigo))) {
    return { tipo: "recusado" };
  }
  let concedido = false;
  let bibliotecaPodeTerAtivado = false;
  try {
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
      bibliotecaPodeTerAtivado = true;
      throw erro;
    }
    bibliotecaPodeTerAtivado = true;
    const idValido = await p.sessaoQueVale(p.sessaoAtualId);
    if (!(await conceder(p.usuarioId, idValido, p.geracao))) {
      return { tipo: "perdida", sessaoId: idValido };
    }
    concedido = true;
    return { tipo: "concedido", codigos };
  } finally {
    // UM só bloco de compensação: toda saída que não seja "concedido" deixa o estado como entrou.
    if (!concedido) {
      if (p.estado === "pendente" && bibliotecaPodeTerAtivado)
        await compensar(() => desfazerAtivacao(p.usuarioId));
      if (reivindicou) await compensar(() => liberarCodigoDeAplicativo(p.usuarioId, p.codigo));
    }
  }
}

// Banco indisponível também para compensar: o erro original é o que sobe; nunca mascarado.
async function compensar(passo: () => Promise<void>): Promise<void> {
  try {
    await passo();
  } catch {
    // sem registro: nada daqui carrega credencial, e o erro original já segue adiante
  }
}
