import "server-only";
import { headers } from "next/headers";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { estadoDoCadastro } from "./sessao-mfa";

// Material do cadastro: o endereço otpauth (para o QR) e a chave em texto. É segredo: vai só à tela
// de quem está cadastrando, nunca a registro, erro ou relatório.
export type MaterialDoCadastro = { uri: string; chave: string };

function materialDe(uri: string): MaterialDoCadastro | null {
  const chave = new URL(uri).searchParams.get("secret");
  return chave ? { uri, chave } : null;
}

// Primeira vez: a biblioteca cria o segredo. Já existe um segredo ainda não ativado (a pessoa
// recarregou a página): mostra o MESMO, para o aplicativo que ela já escaneou continuar valendo.
// Criação simultânea: o índice único (migração 0005) faz a segunda falhar; ela lê a vencedora.
export async function prepararCadastro(userId: string): Promise<MaterialDoCadastro | null> {
  const auth = obterAuth();
  const cabecalhos = await headers();
  if ((await estadoDoCadastro(userId)) === "sem-linha") {
    try {
      const criado = (await auth.api.enableTwoFactor({ body: {}, headers: cabecalhos })) as {
        totpURI?: string;
      };
      if (criado.totpURI) return materialDe(criado.totpURI);
    } catch (erro) {
      // Perdeu a corrida (ou a biblioteca recusou): o estado abaixo diz o que fazer.
      registrarErro("segundo-fator-cadastro-criar", erro);
    }
  }
  if ((await estadoDoCadastro(userId)) !== "pendente") return null;
  try {
    const lido = (await auth.api.getTOTPURI({ body: {}, headers: cabecalhos })) as {
      totpURI?: string;
    };
    return lido.totpURI ? materialDe(lido.totpURI) : null;
  } catch (erro) {
    registrarErro("segundo-fator-cadastro-ler", erro);
    return null;
  }
}
