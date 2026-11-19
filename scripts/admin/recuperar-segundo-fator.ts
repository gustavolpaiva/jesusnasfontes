import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { obterDb, obterPool } from "../../src/db/cliente";
import { doisFatores, sessao } from "../../src/db/schema/entrada";
import { usuario } from "../../src/db/schema/fundacao";
import { registrarErro } from "../../src/lib/registro";
import { chaveDe } from "../../src/modules/identidade/limite";
import { normalizarEmail } from "../../src/modules/identidade/normalizar-email";

// pnpm exec tsx scripts/admin/recuperar-segundo-fator.ts --variavel ADMIN_EMAIL_INICIAL
//
// Recuperação do segundo fator, feita por quem administra o banco (a pessoa perdeu o aparelho e os
// códigos). Numa transação: apaga a linha de auth.two_factor da conta, zera two_factor_enabled e
// apaga TODAS as sessões dela (a linha de admin.sessao_mfa e o contador somem junto, por cascata).
// A próxima entrada exige novo cadastro, com segredo e códigos novos: nada do segundo fator antigo
// sobrevive. Nunca imprime o endereço; o endereço vem de uma variável de ambiente.

export type ResultadoRecuperacao = { codigo: 0 | 2; mensagem: string };

export async function recuperarSegundoFator(emailBruto: string): Promise<ResultadoRecuperacao> {
  const email = normalizarEmail(emailBruto);
  const db = obterDb();
  const resumo = await db.transaction(async (tx) => {
    const [conta] = await tx.select().from(usuario).where(eq(usuario.email, email));
    if (!conta) return null;
    const linhas = await tx
      .delete(doisFatores)
      .where(eq(doisFatores.userId, conta.id))
      .returning({ id: doisFatores.id });
    await tx.update(usuario).set({ twoFactorEnabled: false }).where(eq(usuario.id, conta.id));
    const sessoes = await tx
      .delete(sessao)
      .where(eq(sessao.userId, conta.id))
      .returning({ id: sessao.id });
    // O teto por conta não deve prender o cadastro novo (a chave guarda só um resumo).
    await tx.execute(
      sql`delete from admin.tentativa where chave = ${chaveDe("segundo-fator-conta", conta.id)}`,
    );
    return { segundosFatores: linhas.length, sessoes: sessoes.length };
  });
  if (!resumo) {
    return { codigo: 2, mensagem: "ContaInexistente: nenhuma conta com esse endereço." };
  }
  return {
    codigo: 0,
    mensagem: `segundo fator removido (linhas: ${resumo.segundosFatores}, sessões encerradas: ${resumo.sessoes}); a próxima entrada pede novo cadastro`,
  };
}

function lerVariavel(argumentos: string[]): string | null {
  const i = argumentos.indexOf("--variavel");
  const nome = i >= 0 ? argumentos[i + 1] : undefined;
  if (!nome || !/^[A-Z][A-Z0-9_]*$/.test(nome)) return null;
  return process.env[nome] ?? null;
}

async function principal(): Promise<number> {
  const email = lerVariavel(process.argv.slice(2));
  if (!email) {
    console.error("Uso: --variavel NOME_DA_VARIAVEL (a variável precisa estar definida).");
    return 2;
  }
  const r = await recuperarSegundoFator(email);
  (r.codigo === 0 ? console.log : console.error)(r.mensagem);
  return r.codigo;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal()
    .catch((erro) => {
      registrarErro("recuperar-segundo-fator", erro);
      console.error("ErroAoRecuperarSegundoFator");
      return 1;
    })
    .then(async (codigo) => {
      await obterPool().end();
      process.exit(codigo);
    });
}
