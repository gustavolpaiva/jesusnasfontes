import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { convite, sessao, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { enviarConvite } from "@/modules/identidade/convite";
import { chaveDe, consumirLimite } from "@/modules/identidade/limite";
import {
  CHAVE_TRAVA_DE_ADMINS,
  identificadoresDeVerificacao,
} from "@/modules/privacidade/remover-conta";

// Reenviar e revogar convites (AUTH-06). Sem `"use server"` e sem `exigirAdmin` aqui: quem chama
// (acoes.ts) já provou que é Admin com o segundo fator; este arquivo existe para o teste de
// integração exercitar o efeito no banco sem uma requisição do Next.
//
// As duas operações recebem o ID de um convite e leem a PRÓPRIA linha por esse ID. Nenhuma delas
// escolhe alvo por busca: o que se altera ou apaga é a linha lida, a conta ligada a ela pelo
// endereço gravado nela e as sessões dessa conta, por ID.

export const LIMITE_DE_REENVIO = { maximo: 3, janela: 3600 } as const;

export const chaveDoReenvio = (conviteId: string) => chaveDe("reenviar-convite", conviteId);

export type ResultadoReenvio =
  | { ok: true; email: string; emailSaiu: boolean }
  | { ok: false; erro: "inexistente" | "estado" | "limite" };

// Só convite Pendente é reenviado; no máximo 3 reenvios por convite por hora (consumirLimite, que
// conta também o pedido recusado). O e-mail é o mesmo do convite, pelo mesmo caminho (enviarConvite).
export async function reenviarConviteNucleo(conviteId: string): Promise<ResultadoReenvio> {
  const [linha] = await obterDb()
    .select({ id: convite.id, email: convite.emailNorm, estado: convite.estado })
    .from(convite)
    .where(eq(convite.id, conviteId));
  if (!linha) return { ok: false, erro: "inexistente" };
  if (linha.estado !== "pendente") return { ok: false, erro: "estado" };
  const { permitido } = await consumirLimite(
    chaveDoReenvio(linha.id),
    LIMITE_DE_REENVIO.maximo,
    LIMITE_DE_REENVIO.janela,
  );
  if (!permitido) return { ok: false, erro: "limite" };
  return { ok: true, email: linha.email, emailSaiu: await enviarConvite(linha.email) };
}

export type ResultadoRevogacao =
  | { ok: true; email: string; sessoesEncerradas: number; contaApagada: boolean }
  | { ok: false; erro: "inexistente" | "estado" | "proprio" | "unico-admin" };

// Revoga um convite Pendente ou Aceito, numa transação:
//  - o convite vira `revogado` (e `conviteAtivo` passa a ser falso: novo pedido de acesso recebe a
//    resposta neutra e o gancho de criação de sessão recusa);
//  - TODAS as sessões da pessoa são apagadas (efeito imediato: a próxima navegação cai em /entrar);
//  - códigos e links de entrada pendentes daquele endereço são apagados;
//  - os dados da pessoa NÃO são apagados (decisão adotada do contrato), exceto quando o convite nunca
//    foi aceito: aí a conta vazia sai junto. "Nunca aceito" exige as DUAS provas: `aceito_em` nulo e
//    nenhuma sessão ter existido; qualquer sinal de que a pessoa entrou mantém a conta.
// Recusas: o próprio convite de quem revoga e o convite do único Admin com convite ativo.
//
// Ordem das travas: linha da conta (FOR UPDATE), trava dos Admins (a mesma de apagar a conta), linha
// do convite (FOR UPDATE). É a ordem de `removerConta`, então as duas operações não se prendem uma
// à outra, e dois Admins que se revogam ao mesmo tempo não deixam o grupo sem administração.
export async function revogarConviteNucleo(
  conviteId: string,
  atorId: string,
  { db = obterDb() }: { db?: ReturnType<typeof obterDb> } = {},
): Promise<ResultadoRevogacao> {
  return db.transaction(async (tx) => {
    const [previa] = await tx
      .select({ email: convite.emailNorm })
      .from(convite)
      .where(eq(convite.id, conviteId));
    if (!previa) return { ok: false as const, erro: "inexistente" as const };

    const [conta] = await tx
      .select({ id: usuario.id, papel: usuario.role, jaEntrou: usuario.emailVerified })
      .from(usuario)
      .where(eq(usuario.email, previa.email))
      .for("update");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${CHAVE_TRAVA_DE_ADMINS}, 0))`,
    );
    const [linha] = await tx
      .select({
        email: convite.emailNorm,
        estado: convite.estado,
        aceitoEm: convite.aceitoEm,
      })
      .from(convite)
      .where(eq(convite.id, conviteId))
      .for("update");
    if (!linha) return { ok: false as const, erro: "inexistente" as const };
    if (linha.estado === "revogado") return { ok: false as const, erro: "estado" as const };
    if (conta?.id === atorId) return { ok: false as const, erro: "proprio" as const };

    if (conta?.papel === "admin") {
      const outros = await tx
        .select({ id: usuario.id })
        .from(usuario)
        .innerJoin(convite, eq(convite.emailNorm, usuario.email))
        .where(
          and(
            eq(usuario.role, "admin"),
            ne(usuario.id, conta.id),
            inArray(convite.estado, ["pendente", "aceito"]),
          ),
        )
        .limit(1);
      if (outros.length === 0) return { ok: false as const, erro: "unico-admin" as const };
    }

    await tx
      .update(convite)
      .set({ estado: "revogado", revogadoEm: sql`now()` })
      .where(eq(convite.id, conviteId));
    await tx
      .delete(verificacao)
      .where(
        or(
          inArray(verificacao.identifier, identificadoresDeVerificacao(linha.email)),
          and(
            sql`${verificacao.value} like '{"type":"magic-link"%'`,
            sql`${verificacao.value}::jsonb ->> 'email' = ${linha.email}`,
          ),
        ),
      );
    let sessoesEncerradas = 0;
    let contaApagada = false;
    if (conta) {
      const apagadas = await tx
        .delete(sessao)
        .where(eq(sessao.userId, conta.id))
        .returning({ id: sessao.id });
      sessoesEncerradas = apagadas.length;
      // A conta só sai junto se NUNCA foi usada, e a prova tem de durar: convite nunca aceito, nenhuma
      // sessão agora e o e-mail nunca confirmado por uma entrada (a biblioteca grava isso na conta ao
      // entrar por link ou por código). Sessão aberta é sinal de uso: como ela é apagada aqui, o sinal
      // fica gravado na conta, senão uma segunda revogação depois de reconvidar veria a conta "vazia"
      // e levaria por cascata as Anotações, o progresso e o consentimento da pessoa.
      if (sessoesEncerradas > 0 && !conta.jaEntrou) {
        await tx.update(usuario).set({ emailVerified: true }).where(eq(usuario.id, conta.id));
      }
      if (linha.aceitoEm === null && sessoesEncerradas === 0 && !conta.jaEntrou) {
        await tx.delete(usuario).where(eq(usuario.id, conta.id));
        contaApagada = true;
      }
    }
    return { ok: true as const, email: linha.email, sessoesEncerradas, contaApagada };
  });
}
