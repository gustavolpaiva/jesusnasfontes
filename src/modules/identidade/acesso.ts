import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { eq } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { verificacao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { modeloEntrada } from "@/lib/email";
import { urlBase } from "@/lib/env";
import { conviteAtivo } from "./convite";

// O pedido de acesso, igual para endereço convidado ou não. Fica fora do arquivo de Server
// Actions para o teste de equivalência poder chamá-lo e contar as operações de banco.
//
// Convidado (a biblioteca, mais o nosso sendMagicLink), nesta ordem:
//   1 select convite · 2 insert verificação (link) · 3 select convite · 4 delete verificação
//   (apagarCodigoDe) · 5 insert verificação (código) · e o e-mail, depois da resposta (waitUntil).
// Não convidado: as mesmas cinco operações, com a mesma forma, em linhas de nome aleatório que já
// nascem vencidas; a última é apagada depois da resposta, como o e-mail do convidado.
// O convidado também gera um token e um código, resume os dois e monta a mensagem; o não
// convidado faz o mesmo trabalho de CPU e descarta o resultado.
function gastarCpuComoOConvidado(email: string): void {
  const token = randomBytes(24).toString("base64url");
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
  createHash("sha256").update(token).digest("base64url");
  createHash("sha256").update(codigo).digest("base64url");
  modeloEntrada({
    para: email,
    urlConfirmar: `${urlBase()}/entrar/confirmar?token=${token}`,
    codigo,
  });
}

async function trabalhoEquivalente(email: string): Promise<void> {
  const db = obterDb();
  const vencida = new Date(Date.now() - 60_000);
  gastarCpuComoOConvidado(email);
  const a = `equivalente-${crypto.randomUUID()}`;
  const b = `equivalente-${crypto.randomUUID()}`;
  await db.insert(verificacao).values({ identifier: a, value: "x", expiresAt: vencida });
  await conviteAtivo(email);
  await db.delete(verificacao).where(eq(verificacao.identifier, a));
  await db.insert(verificacao).values({ identifier: b, value: "x", expiresAt: vencida });
  waitUntil(
    db
      .delete(verificacao)
      .where(eq(verificacao.identifier, b))
      .then(
        () => undefined,
        () => undefined,
      ),
  );
}

export async function darAcesso(email: string, cabecalhos: Headers): Promise<void> {
  if (await conviteAtivo(email)) {
    await obterAuth().api.signInMagicLink({ body: { email }, headers: cabecalhos });
  } else {
    await trabalhoEquivalente(email);
  }
}
