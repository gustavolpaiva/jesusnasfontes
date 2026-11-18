import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { obterDb, obterPool } from "../../src/db/cliente";
import { usuario } from "../../src/db/schema/fundacao";
import { envAdmin } from "../../src/lib/env";
import { registrarErro } from "../../src/lib/registro";
import { ConviteDuplicado, convidar } from "../../src/modules/identidade/convite";
import { normalizarEmail } from "../../src/modules/identidade/normalizar-email";

// pnpm admin:semear — garante o Admin inicial (ADMIN_EMAIL_INICIAL): usuário com papel admin e
// convite pendente, que vira aceito na primeira entrada. Idempotente. Não envia e-mail de convite
// e nunca imprime o endereço.

async function principal(): Promise<number> {
  const email = normalizarEmail(envAdmin().ADMIN_EMAIL_INICIAL);
  try {
    await convidar(email, null, { papel: "admin", enviar: false });
    console.log("admin criado");
    return 0;
  } catch (erro) {
    if (!(erro instanceof ConviteDuplicado)) throw erro;
  }
  const atual = await obterDb()
    .select({ role: usuario.role })
    .from(usuario)
    .where(eq(usuario.email, email));
  if (atual[0] && atual[0].role !== "admin") {
    await obterDb().update(usuario).set({ role: "admin" }).where(eq(usuario.email, email));
    console.log("admin ajustado");
  } else {
    console.log("já existe");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal()
    .then(
      (codigo) => codigo,
      (erro) => {
        registrarErro("semear-admin", erro);
        console.error("ErroAoSemearAdmin");
        return 1;
      },
    )
    .then(async (codigo) => {
      await obterPool().end();
      process.exit(codigo);
    });
}
