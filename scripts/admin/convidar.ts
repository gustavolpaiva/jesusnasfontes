import { pathToFileURL } from "node:url";
import { registrarErro } from "../../src/lib/registro";
import { ConviteDuplicado, convidar } from "../../src/modules/identidade/convite";
import { lerEmail } from "../../src/modules/identidade/normalizar-email";

// pnpm convidar -- --email <endereço>   ou   pnpm convidar -- --variavel <NOME>
// A segunda forma lê o endereço de uma variável de ambiente, para ele não entrar na linha de
// comando. Imprime só "convite criado" ou o nome do erro: nunca o endereço.

function lerArgumento(argumentos: string[], nome: string): string | undefined {
  const indice = argumentos.indexOf(nome);
  return indice >= 0 ? argumentos[indice + 1] : undefined;
}

async function principal(): Promise<number> {
  const argumentos = process.argv.slice(2);
  const nomeVariavel = lerArgumento(argumentos, "--variavel");
  const bruto = nomeVariavel ? process.env[nomeVariavel] : lerArgumento(argumentos, "--email");
  const email = lerEmail(bruto);
  if (!email) {
    console.error(
      nomeVariavel
        ? "EmailInvalido: a variável não existe ou não traz um e-mail válido"
        : "Uso: convidar -- --email <endereço> | --variavel <NOME>",
    );
    return 1;
  }
  try {
    await convidar(email, null);
    console.log("convite criado");
    return 0;
  } catch (erro) {
    if (erro instanceof ConviteDuplicado) {
      console.error("ConviteDuplicado");
      return 1;
    }
    registrarErro("convidar", erro);
    console.error("ErroAoConvidar");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().then(
    (codigo) => process.exit(codigo),
    () => process.exit(1),
  );
}
