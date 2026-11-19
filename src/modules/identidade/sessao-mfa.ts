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

// SERIALIZAÇÃO por conta. Toda decisão de segurança que LÊ o estado do segundo fator e depois ESCREVE
// nele (conceder, desfazer a ativação, a recuperação) roda numa transação CURTA e própria, numa só
// conexão, que começa travando a linha de geração da conta (`for update`) e só então lê e decide.
// `UPDATE … WHERE NOT EXISTS (…)` sozinho não basta em READ COMMITTED (a subconsulta vê o retrato do
// início da instrução); a trava de linha é que serializa. Nada dentro dessas transações chama a
// biblioteca, e-mail ou qualquer coisa que use outra conexão (o pool pode ser de uma só).
// Ordem de travas, igual em todo lugar: linha de geração, depois linha do usuário.
type Transacao = Parameters<Parameters<ReturnType<typeof obterDb>["transaction"]>[0]>[0];

async function sobTravaDaConta<T>(
  userId: string,
  decidir: (tx: Transacao, geracao: number) => Promise<T>,
): Promise<T> {
  return obterDb().transaction(async (tx) => {
    await tx.execute(sql`
      insert into admin.segundo_fator_geracao (user_id, geracao) values (${userId}, 0)
      on conflict (user_id) do nothing`);
    const travada = await tx.execute<{ g: number }>(sql`
      select geracao::int as g from admin.segundo_fator_geracao where user_id = ${userId} for update`);
    return decidir(tx, Number(travada.rows[0]?.g ?? 0));
  });
}

// O FATO gravado: o segundo fator desta geração já foi concedido (ativado e usado) ao menos uma vez.
// Não depende de sessões (que somem no logout, na expiração e no encerramento pela guarda). Só a
// recuperação pelo dono o limpa, ao subir a geração.
export async function fatoConcedido(userId: string): Promise<boolean> {
  const r = await obterDb().execute(sql`
    select 1 from admin.segundo_fator_geracao where user_id = ${userId} and concedido_em is not null`);
  return r.rows.length > 0;
}

// Concede o acesso, sob a trava da conta: só marca a sessão se (1) a geração ainda é a que a
// conferência leu ao começar e (2) o fator está de fato ativo agora (uma compensação concorrente pode
// tê-lo devolvido a pendente: nesse caso nada é concedido). Se uma recuperação passou no meio, o
// estado que a biblioteca ressuscitou ("ativo" sem linha de fator) é desfeito.
export async function concederSegundoFator(
  userId: string,
  sessionId: string,
  geracaoInicial: number,
): Promise<boolean> {
  return sobTravaDaConta(userId, async (tx, geracao) => {
    if (geracao !== geracaoInicial) {
      await tx.execute(sql`
        update auth."user" set two_factor_enabled = false
        where id = ${userId} and two_factor_enabled
          and not exists (select 1 from auth.two_factor t where t.user_id = ${userId})`);
      return false;
    }
    const ativo = await tx.execute(
      sql`select 1 from auth.two_factor where user_id = ${userId} and verified is true limit 1`,
    );
    if (ativo.rows.length === 0) return false;
    const r = await tx.execute(sql`
      insert into admin.sessao_mfa (session_id, geracao) values (${sessionId}, ${geracao})
      on conflict (session_id) do update set geracao = excluded.geracao, verificado_em = now()
      returning session_id`);
    if (r.rows.length === 0) return false;
    // O fato, na mesma transação e sob a mesma trava que a marca da sessão.
    await tx.execute(sql`
      update admin.segundo_fator_geracao set concedido_em = coalesce(concedido_em, now())
      where user_id = ${userId}`);
    return true;
  });
}

// Desfaz uma ativação que a biblioteca fez mas que não chegou a ser concedida nem entregue com os
// códigos (falha de banco no meio): volta o cadastro a "pendente", para a pessoa tentar do começo
// com o mesmo segredo. Por id da conta, sob a trava, e só se o fato "concedido" não está gravado:
// depois de o fator ter sido usado com sucesso, só a recuperação do dono o devolve a pendente. `aposLer` é um ponto de espera para teste (entre a leitura e a escrita, sob a trava).
export async function desfazerAtivacao(
  userId: string,
  geracaoDaTentativa: number,
  aposLer?: () => Promise<void>,
): Promise<void> {
  await sobTravaDaConta(userId, async (tx, geracaoAtual) => {
    // A tentativa só desfaz o que é da geração em que começou: se uma recuperação passou, o que está
    // aí é de outra tentativa, em outra geração, e não lhe cabe tocar.
    if (geracaoAtual !== geracaoDaTentativa) return;
    // Decide pelo FATO gravado, nunca por sessões: depois da primeira concessão da geração, só a
    // recuperação pelo dono devolve o fator a pendente.
    const fato = await tx.execute(sql`
      select 1 from admin.segundo_fator_geracao where user_id = ${userId} and concedido_em is not null`);
    await aposLer?.();
    if (fato.rows.length > 0) return;
    await tx.execute(sql`update auth.two_factor set verified = false where user_id = ${userId}`);
    await tx.execute(sql`update auth."user" set two_factor_enabled = false where id = ${userId}`);
  });
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

// Compensação de `reivindicarCodigoDeAplicativo`: só quem reivindicou e NÃO concedeu nada a chama.
// Um código que concedeu continua marcado (e recusado) pelo resto da janela.
export async function liberarCodigoDeAplicativo(
  userId: string,
  codigo: string,
  geracaoDaTentativa: number,
): Promise<void> {
  // Sob a trava e só na geração em que a tentativa começou (a reivindicação é dela).
  await sobTravaDaConta(userId, async (tx, geracaoAtual) => {
    if (geracaoAtual !== geracaoDaTentativa) return;
    await tx.execute(
      sql`delete from admin.tentativa where chave = ${chaveDe("totp-usado", `${userId}:${codigo}`)}`,
    );
  });
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
