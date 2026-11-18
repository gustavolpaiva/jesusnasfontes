import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { obterDb, obterPool } from "../../src/db/cliente";
import { convite } from "../../src/db/schema/entrada";
import { usuario } from "../../src/db/schema/fundacao";
import { envAdmin } from "../../src/lib/env";
import { registrarErro } from "../../src/lib/registro";
import { normalizarEmail } from "../../src/modules/identidade/normalizar-email";

// pnpm admin:semear — garante o Admin inicial (ADMIN_EMAIL_INICIAL). Idempotente. Não envia e-mail
// e nunca imprime o endereço. A mensagem final descreve o estado LIDO do banco depois do ato.
//
// Estados de partida e o que o script faz:
//   não existe nada            → cria usuário admin e convite pendente        ("admin criado")
//   admin com convite ativo    → nada                                         ("já existe")
//   estudante com convite ativo→ promove a admin (o operador nomeou o endereço) ("admin ajustado")
//   usuário sem convite        → cria o convite pendente (e o papel admin)     ("admin ajustado")
//   convite REVOGADO           → RECUSA, exit 2: reativar é decisão de quem administra
// Promover a admin é o propósito da variável; reativar um convite revogado desfaz uma decisão.

export type ResultadoSemeadura = { codigo: 0 | 2; mensagem: string };

export async function semearAdmin(emailBruto: string): Promise<ResultadoSemeadura> {
  const email = normalizarEmail(emailBruto);
  const db = obterDb();
  const acoes: string[] = [];
  const recusa = await db.transaction(async (tx) => {
    const [conta] = await tx.select().from(usuario).where(eq(usuario.email, email));
    const [convida] = await tx.select().from(convite).where(eq(convite.emailNorm, email));
    if (convida?.estado === "revogado") return true;
    if (!conta) {
      await tx.insert(usuario).values({ email, role: "admin" });
      acoes.push("usuário criado");
    } else if (conta.role !== "admin") {
      await tx.update(usuario).set({ role: "admin" }).where(eq(usuario.email, email));
      acoes.push("promovido a admin");
    }
    if (!convida) {
      await tx.insert(convite).values({ emailNorm: email, estado: "pendente" });
      acoes.push("convite criado");
    }
    return false;
  });
  if (recusa) {
    return {
      codigo: 2,
      mensagem:
        "ConviteRevogado: o convite deste endereço foi revogado; o script não o reativa. Reativar é decisão de quem administra.",
    };
  }
  // Estado depois do ato, lido do banco.
  const [conta] = await db.select().from(usuario).where(eq(usuario.email, email));
  const [convida] = await db.select().from(convite).where(eq(convite.emailNorm, email));
  const estado = `papel ${conta?.role}, convite ${convida?.estado}`;
  if (acoes.length === 0) return { codigo: 0, mensagem: `já existe (${estado})` };
  const rotulo = acoes[0] === "usuário criado" ? "admin criado" : "admin ajustado";
  return { codigo: 0, mensagem: `${rotulo}: ${acoes.join(", ")} (${estado})` };
}

async function principal(): Promise<number> {
  const resultado = await semearAdmin(envAdmin().ADMIN_EMAIL_INICIAL);
  (resultado.codigo === 0 ? console.log : console.error)(resultado.mensagem);
  return resultado.codigo;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal()
    .catch((erro) => {
      registrarErro("semear-admin", erro);
      console.error("ErroAoSemearAdmin");
      return 1;
    })
    .then(async (codigo) => {
      await obterPool().end();
      process.exit(codigo);
    });
}
