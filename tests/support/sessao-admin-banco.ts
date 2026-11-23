import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

// Cria, pelo DONO do banco, uma conta e uma sessão em cada estado que a prova de sessão do Acervo
// precisa distinguir. Só para banco descartável de teste: o e-mail é fictício e o token é aleatório.
//
//   admin-com-segundo-fator  Admin, sessão viva e marca de segundo fator na geração atual da conta
//   admin-sem-segundo-fator  Admin, sessão viva, sem linha em admin.sessao_mfa
//   estudante                Estudante, sessão viva e (de propósito) com marca de segundo fator
//   geracao-antiga           Admin com marca de uma geração que a recuperação já substituiu
//   sessao-vencida           Admin com marca de segundo fator na geração atual, sessão já vencida

export type CasoDeSessao =
  | "admin-com-segundo-fator"
  | "admin-sem-segundo-fator"
  | "estudante"
  | "geracao-antiga"
  | "sessao-vencida";

export type SessaoDeTeste = { sessaoId: string; usuarioId: string };

export async function criarSessaoDeTeste(
  dono: pg.Client,
  caso: CasoDeSessao,
): Promise<SessaoDeTeste> {
  const papel = caso === "estudante" ? "estudante" : "admin";
  const usuario = await dono.query<{ id: string }>(
    `insert into auth."user" (email, email_verified, role, two_factor_enabled)
     values ($1, true, $2, $3) returning id`,
    [`${randomUUID()}@exemplo.invalid`, papel, caso !== "admin-sem-segundo-fator"],
  );
  const usuarioId = (usuario.rows[0] as { id: string }).id;
  const vencida = caso === "sessao-vencida";
  const sessao = await dono.query<{ id: string }>(
    `insert into auth.session (user_id, token, expires_at)
     values ($1, $2, now() + ($3 || ' hours')::interval) returning id`,
    [usuarioId, randomBytes(16).toString("hex"), vencida ? "-2" : "2"],
  );
  const sessaoId = (sessao.rows[0] as { id: string }).id;

  // Geração atual da conta: 2 no caso da marca antiga (a recuperação passou), 1 nos demais.
  const geracaoDaConta = caso === "geracao-antiga" ? 2 : 1;
  await dono.query("insert into admin.segundo_fator_geracao (user_id, geracao) values ($1, $2)", [
    usuarioId,
    geracaoDaConta,
  ]);
  if (caso !== "admin-sem-segundo-fator") {
    // A marca é sempre da geração 1: no caso `geracao-antiga` a conta já está na 2.
    await dono.query("insert into admin.sessao_mfa (session_id, geracao) values ($1, 1)", [
      sessaoId,
    ]);
  }
  return { sessaoId, usuarioId };
}
