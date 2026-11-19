import "server-only";
import { eq, sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { doisFatores } from "@/db/schema/entrada";
import { chaveDe, chaveSegundoFatorDaConta, consumirLimite } from "./limite";

// Estado do segundo fator no banco. Fica fora do arquivo de Server Actions (`segundo-fator.ts`):
// tudo o que um arquivo "use server" exporta é chamável pelo navegador, e estas funções não podem
// ser.
//
// Onde mora cada coisa:
//   auth.two_factor           segredo e códigos de recuperação, cifrados pela biblioteca com
//                             BETTER_AUTH_SECRET; uma linha por conta (índice único, migração 0005)
//   auth.user.two_factor_enabled   a biblioteca liga ao ativar
//   admin.sessao_mfa          QUAL sessão já provou o segundo fator (uma linha por sessão; a
//                             linha some com a sessão, por cascata)
//   admin.falha_segundo_fator tentativas gastas por sessão
//   admin.tentativa           limite por conta e marca de "código de aplicativo já usado"

export const TENTATIVAS_POR_SESSAO = 5;
// Teto por conta, somando todas as sessões: quem tem só a caixa de e-mail abre uma sessão nova a
// cada link, e sem teto de conta cada sessão daria cinco palpites novos.
export const LIMITE_POR_CONTA = { maximo: 10, janela: 3600 } as const;
// O código de aplicativo vale por até 90 s (a biblioteca aceita o passo anterior e o seguinte).
const JANELA_DE_REUSO_SEGUNDOS = 120;

// Geração do segundo fator da conta: sobe quando a recuperação apaga o segundo fator (mesma
// transação). Sem linha, é 0.
const GERACAO_ATUAL = (userId: unknown) =>
  sql`coalesce((select g.geracao from admin.segundo_fator_geracao g where g.user_id = ${userId}), 0)`;

export async function geracaoDoSegundoFator(userId: string): Promise<number> {
  const r = await obterDb().execute<{ g: number }>(sql`select ${GERACAO_ATUAL(userId)}::int as g`);
  return Number(r.rows[0]?.g ?? 0);
}

// A sessão só conta como verificada se a marca foi dada NA geração atual da conta: uma marca de
// geração anterior (a recuperação passou no meio) vale como não verificada.
export async function sessaoVerificada(sessionId: string): Promise<boolean> {
  const r = await obterDb().execute(sql`
    select 1
    from admin.sessao_mfa m
    join auth.session s on s.id = m.session_id
    where m.session_id = ${sessionId}
      and m.geracao = ${GERACAO_ATUAL(sql`s.user_id`)}
    limit 1`);
  return r.rows.length > 0;
}

// Concede o acesso: UMA instrução que só marca a sessão se a geração da conta ainda é a que a
// conferência leu ao começar (compare-and-set). Se uma recuperação passou no meio, nada é concedido
// e o estado que a biblioteca ressuscitou ("ativo" sem linha de segundo fator) é desfeito.
export async function concederSegundoFator(
  userId: string,
  sessionId: string,
  geracaoInicial: number,
): Promise<boolean> {
  const db = obterDb();
  const r = await db.execute(sql`
    insert into admin.sessao_mfa (session_id, geracao)
    select ${sessionId}, ${geracaoInicial}
    where ${GERACAO_ATUAL(userId)} = ${geracaoInicial}
    on conflict (session_id) do update set geracao = excluded.geracao, verificado_em = now()
    returning session_id`);
  if (r.rows.length > 0) return true;
  await db.execute(sql`
    update auth."user" set two_factor_enabled = false
    where id = ${userId} and two_factor_enabled
      and not exists (select 1 from auth.two_factor t where t.user_id = ${userId})`);
  return false;
}

// Reserva UMA tentativa da sessão, antes de comparar nada, numa única instrução atômica (a linha é
// travada pelo upsert, então requisições simultâneas recebem contagens distintas). Só quem fica
// dentro do teto chega à comparação. A reserva vale também se o código acertar.
export async function reservarTentativaDaSessao(
  sessionId: string,
): Promise<{ concedida: boolean; usadas: number }> {
  const resultado = await obterDb().execute<{ falhas: number }>(sql`
    insert into admin.falha_segundo_fator (session_id, falhas, atualizado_em)
    values (${sessionId}, 1, now())
    on conflict (session_id) do update
      set falhas = admin.falha_segundo_fator.falhas + 1, atualizado_em = now()
    returning falhas`);
  const usadas = Number(resultado.rows[0]?.falhas ?? Number.POSITIVE_INFINITY);
  return { concedida: usadas <= TENTATIVAS_POR_SESSAO, usadas };
}

// Mesma regra para a conta: janela ancorada no primeiro evento (`consumirLimite`).
export async function reservarTentativaDaConta(userId: string): Promise<boolean> {
  const { permitido } = await consumirLimite(
    chaveSegundoFatorDaConta(userId),
    LIMITE_POR_CONTA.maximo,
    LIMITE_POR_CONTA.janela,
  );
  return permitido;
}

// A biblioteca confere o código de aplicativo sem lembrar dele: o mesmo código vale de novo até
// vencer. Aqui cada código vale uma vez por conta: a primeira marca ganha (instrução atômica); a
// chave guarda só um resumo do par conta e código.
export async function reivindicarCodigoDeAplicativo(
  userId: string,
  codigo: string,
): Promise<boolean> {
  const { permitido } = await consumirLimite(
    chaveDe("totp-usado", `${userId}:${codigo}`),
    1,
    JANELA_DE_REUSO_SEGUNDOS,
  );
  return permitido;
}

export type EstadoDoCadastro = "sem-linha" | "pendente" | "ativo";

export async function estadoDoCadastro(userId: string): Promise<EstadoDoCadastro> {
  const linhas = await obterDb()
    .select({ verificado: doisFatores.verified })
    .from(doisFatores)
    .where(eq(doisFatores.userId, userId))
    .limit(1);
  const linha = linhas[0];
  if (!linha) return "sem-linha";
  // A coluna aceita nulo por desenho da biblioteca; só `true` conta como ativo.
  return linha.verificado === true ? "ativo" : "pendente";
}
