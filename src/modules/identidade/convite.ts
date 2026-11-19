import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { convite, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { enviarEmail, modeloConvite } from "@/lib/email";
import { urlBase } from "@/lib/env";
import { chaveFalhasDoCodigo, zerarLimite } from "./limite";
import { normalizarEmail } from "./normalizar-email";

// Sem `server-only`: o comando `pnpm convidar` também usa este módulo.

export class ConviteDuplicado extends Error {
  constructor() {
    super("Já existe convite para este endereço.");
    this.name = "ConviteDuplicado";
  }
}

// Convite que vale para entrar: pendente ou aceito (nunca revogado, nunca inexistente).
export async function conviteAtivo(email: string): Promise<boolean> {
  const linhas = await obterDb()
    .select({ id: convite.id })
    .from(convite)
    .where(
      and(
        eq(convite.emailNorm, normalizarEmail(email)),
        inArray(convite.estado, ["pendente", "aceito"]),
      ),
    )
    .limit(1);
  return linhas.length > 0;
}

// Grava o convite pendente e o usuário (a biblioteca recusa entrar com usuário inexistente) e
// envia o e-mail de convite. Convite pendente ou aceito: ConviteDuplicado.
export async function convidar(
  email: string,
  criadoPor: string | null,
  opcoes: { papel?: "estudante" | "admin"; enviar?: boolean } = {},
): Promise<void> {
  const emailNorm = normalizarEmail(email);
  const papel = opcoes.papel ?? "estudante";
  await obterDb().transaction(async (tx) => {
    const existente = await tx
      .select({ estado: convite.estado })
      .from(convite)
      .where(eq(convite.emailNorm, emailNorm))
      .limit(1);
    if (existente[0] && existente[0].estado !== "revogado") throw new ConviteDuplicado();
    if (existente[0]) {
      await tx
        .update(convite)
        .set({ estado: "pendente", revogadoEm: null, criadoPor })
        .where(eq(convite.emailNorm, emailNorm));
    } else {
      await tx.insert(convite).values({ emailNorm, estado: "pendente", criadoPor });
    }
    await tx.insert(usuario).values({ email: emailNorm, role: papel }).onConflictDoNothing();
  });
  if (opcoes.enviar !== false) {
    await enviarEmail(modeloConvite({ para: emailNorm, urlEntrar: `${urlBase()}/entrar` }));
  }
}

// Marca o convite como aceito e apaga as verificações que sobraram daquele endereço (links e
// códigos ainda não usados), para nada que foi pedido antes valer depois da entrada. É o ponto único
// por onde passa toda entrada bem-sucedida (link e código): aqui também zeram as falhas do código
// do endereço. Só aqui: pedido de acesso, reenvio e saída nunca zeram (um terceiro sem credencial
// não pode ganhar palpites).
export async function aceitarConvite(email: string): Promise<void> {
  const emailNorm = normalizarEmail(email);
  const db = obterDb();
  await db
    .update(convite)
    .set({ estado: "aceito", aceitoEm: sql`now()` })
    .where(and(eq(convite.emailNorm, emailNorm), eq(convite.estado, "pendente")));
  await apagarVerificacoesDe(emailNorm);
  await zerarLimite(chaveFalhasDoCodigo(emailNorm));
}

// Código de 6 dígitos: identificador `sign-in-otp-<e-mail>`. Link: o valor guarda o e-mail em JSON.
export async function apagarVerificacoesDe(emailNorm: string): Promise<void> {
  await obterDb()
    .delete(verificacao)
    .where(
      or(
        eq(verificacao.identifier, `sign-in-otp-${emailNorm}`),
        and(
          like(verificacao.value, '{"type":"magic-link"%'),
          sql`${verificacao.value}::jsonb ->> 'email' = ${emailNorm}`,
        ),
      ),
    );
}

// Esgotamento do código: remove SÓ o código daquele endereço (identificador exato, parametrizado).
// Os links pendentes do mesmo endereço e tudo de outros endereços ficam: quem só conhece o e-mail
// não pode, errando o código, cancelar a entrada de quem recebeu o link.
export async function apagarCodigoDe(emailNorm: string): Promise<void> {
  await obterDb()
    .delete(verificacao)
    .where(eq(verificacao.identifier, `sign-in-otp-${normalizarEmail(emailNorm)}`));
}
