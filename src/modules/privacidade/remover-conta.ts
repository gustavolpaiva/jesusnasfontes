import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { convite, tentativa, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { chaveDe, chaveFalhasDoCodigo } from "@/modules/identidade/limite";
import { travarProgresso } from "@/modules/trilhas/consultas";

// O núcleo de apagar a conta (PRIV-03, ANOT-05): uma transação, só a conta indicada, por ID. Sem
// `"use server"` e sem `exigirSessao` aqui: quem chama (apagar.ts) já provou quem é a pessoa; este
// arquivo recebe o ID da própria sessão e nunca um resultado de busca.
//
// Ordem das travas (a mesma das escritas de progresso, então não há impasse): trava de progresso do
// Estudante, depois a linha do usuário com FOR UPDATE. Quem estiver escrevendo progresso agora termina
// antes (a linha e a cascata enxergam o que foi gravado) e quem chegar depois recebe a violação da chave
// estrangeira, que as ações tratam como sessão encerrada: não sobra linha órfã.

export const ERRO_UNICO_ADMIN = "unico-admin" as const;

export type ResultadoRemocao =
  | { ok: true }
  | { ok: false; erro: typeof ERRO_UNICO_ADMIN | "inexistente" };

// Todos os identificadores de verificação que carregam o endereço (códigos de entrada e de confirmação).
export function identificadoresDeVerificacao(email: string): string[] {
  return [`sign-in-otp-${email}`, `email-verification-otp-${email}`];
}

// Chaves de limite que são só da pessoa (resumos do e-mail e do ID); as por IP não têm como ser ligadas a ela.
export function chavesDeLimiteDaConta(email: string, id: string): string[] {
  return [
    chaveDe("pedido-email", email),
    chaveFalhasDoCodigo(email),
    chaveDe("segundo-fator-conta", id),
    chaveDe("segundo-fator-criacao", id),
    chaveDe("apagar-palpite", id),
    chaveDe("apagar-pedido", id),
  ];
}

// Um só Admin apagando por vez: sem isso, dois Admins apagando juntos deixariam o grupo sem nenhum.
// Exportada: revogar o convite de um Admin (módulo de convites) toma a MESMA trava.
export const CHAVE_TRAVA_DE_ADMINS = "jnf-admins";

export async function removerConta(
  estudanteId: string,
  { db = obterDb() }: { db?: ReturnType<typeof obterDb> } = {},
): Promise<ResultadoRemocao> {
  return db.transaction(async (tx) => {
    await travarProgresso(tx, estudanteId);
    const [conta] = await tx
      .select({ email: usuario.email, papel: usuario.role })
      .from(usuario)
      .where(eq(usuario.id, estudanteId))
      .for("update");
    if (!conta) return { ok: false as const, erro: "inexistente" as const };

    if (conta.papel === "admin") {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${CHAVE_TRAVA_DE_ADMINS}, 0))`,
      );
      // Outro Admin com convite ativo? Sem ele, apagar esta conta deixaria o grupo sem administração.
      const outros = await tx
        .select({ id: usuario.id })
        .from(usuario)
        .innerJoin(convite, eq(convite.emailNorm, usuario.email))
        .where(
          and(
            eq(usuario.role, "admin"),
            ne(usuario.id, estudanteId),
            inArray(convite.estado, ["pendente", "aceito"]),
          ),
        )
        .limit(1);
      if (outros.length === 0) return { ok: false as const, erro: ERRO_UNICO_ADMIN };
    }

    // Sem vínculo por chave estrangeira com a conta: o convite (pelo endereço), as verificações
    // pendentes (pelo identificador exato ou pelo endereço dentro do link) e os contadores da pessoa.
    await tx.delete(convite).where(eq(convite.emailNorm, conta.email));
    await tx
      .delete(verificacao)
      .where(
        or(
          inArray(verificacao.identifier, identificadoresDeVerificacao(conta.email)),
          and(
            sql`${verificacao.value} like '{"type":"magic-link"%'`,
            sql`${verificacao.value}::jsonb ->> 'email' = ${conta.email}`,
          ),
        ),
      );
    await tx
      .delete(tentativa)
      .where(inArray(tentativa.chave, chavesDeLimiteDaConta(conta.email, estudanteId)));
    // As chaves estrangeiras em cascata levam sessões, contas da biblioteca, segundo fator e toda
    // tabela de `privado`.
    await tx.delete(usuario).where(eq(usuario.id, estudanteId));
    return { ok: true as const };
  });
}
