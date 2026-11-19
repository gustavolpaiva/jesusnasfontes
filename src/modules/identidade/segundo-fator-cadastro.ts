import "server-only";
import { headers } from "next/headers";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { chaveDaCriacaoDoSegundoFator, consumirLimite } from "./limite";
import { estadoDoCadastro, fatoConcedido } from "./sessao-mfa";

// Material do cadastro: o endereço otpauth (para o QR) e a chave em texto. É segredo: vai só à tela
// de quem está cadastrando, nunca a registro, erro ou relatório.
export type MaterialDoCadastro = { uri: string; chave: string };

function materialDe(uri: string): MaterialDoCadastro | null {
  const chave = new URL(uri).searchParams.get("secret");
  return chave ? { uri, chave } : null;
}

const JANELA_DA_CRIACAO_SEGUNDOS = 15;

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

// A biblioteca TROCA o segredo de uma conta cujo cadastro ainda não foi ativado. Duas requisições
// de página simultâneas (a navegação e uma pré-carga) fariam a segunda trocar o segredo que a
// primeira acabou de mostrar, e o código do aplicativo já escaneado deixaria de valer. Só quem
// ganha a reserva atômica da criação chama `enableTwoFactor`; as outras esperam a linha existir e
// só LEEM. (Trava consultiva do banco não serve aqui: ela prenderia uma conexão do pool enquanto a
// biblioteca pede outras, o mesmo esgotamento que o pool de uma conexão do 01-05 expõe.)
async function criarSeAindaNaoExiste(userId: string): Promise<void> {
  const cabecalhos = await headers();
  const { permitido } = await consumirLimite(
    chaveDaCriacaoDoSegundoFator(userId),
    1,
    JANELA_DA_CRIACAO_SEGUNDOS,
  );
  if (permitido) {
    // Confere de novo depois de ganhar a reserva: a linha pode ter nascido entre a primeira leitura e agora.
    if ((await estadoDoCadastro(userId)) !== "sem-linha") return;
    try {
      await obterAuth().api.enableTwoFactor({ body: {}, headers: cabecalhos });
    } catch (erro) {
      registrarErro("segundo-fator-cadastro-criar", erro);
    }
    return;
  }
  for (let i = 0; i < 50 && (await estadoDoCadastro(userId)) === "sem-linha"; i++) {
    await dormir(100);
  }
}

// Primeira vez: a biblioteca cria o segredo. Já existe um segredo ainda não ativado (a pessoa
// recarregou a página): mostra o MESMO, para o aplicativo que ela já escaneou continuar valendo.
export async function prepararCadastro(userId: string): Promise<MaterialDoCadastro | null> {
  // Fato gravado (o fator desta geração já foi concedido): nunca cria cadastro nem mostra segredo,
  // qualquer que seja o estado das sessões ou da linha (falha fechada).
  if (await fatoConcedido(userId)) return null;
  if ((await estadoDoCadastro(userId)) === "sem-linha") await criarSeAindaNaoExiste(userId);
  if ((await estadoDoCadastro(userId)) !== "pendente") return null;
  try {
    const lido = (await obterAuth().api.getTOTPURI({ body: {}, headers: await headers() })) as {
      totpURI?: string;
    };
    // Releitura depois de pedir o segredo: se o fator foi ativado nesse meio tempo, não se mostra.
    if ((await estadoDoCadastro(userId)) !== "pendente" || (await fatoConcedido(userId)))
      return null;
    return lido.totpURI ? materialDe(lido.totpURI) : null;
  } catch (erro) {
    registrarErro("segundo-fator-cadastro-ler", erro);
    return null;
  }
}
