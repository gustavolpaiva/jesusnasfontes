import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { chavesDeLimiteDaConta } from "../../src/modules/privacidade/remover-conta";
import { type BancoDeExecucao, criarBancoPreparado } from "./banco-local";

// Banco descartável com duas contas COMPLETAS (A e B): uma linha em toda tabela de `privado` e em toda
// tabela da biblioteca de entrada que guarda algo da pessoa. É o terreno dos testes de exportar e de
// apagar a conta. Cria linhas, então só roda no banco local descartável (nunca no Neon).

export type Conta = { id: string; email: string; marcador: string; sessaoId: string };

export type Terreno = {
  banco: BancoDeExecucao;
  env: Record<string, string>;
  estudos: [string, string];
  trilha: string;
  a: Conta;
  b: Conta;
  /** Convite de uma terceira pessoa, criado pela conta A (criado_por → A, "set null" ao apagar A). */
  convidadoPorA: string;
};

export async function comoDono<T>(
  env: Record<string, string>,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const cliente = new pg.Client({ connectionString: env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

async function comoCarga<T>(
  env: Record<string, string>,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, env),
  });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

const hash = (texto: string) => createHash("sha256").update(texto).digest("hex");

// Semeia, como dono do banco (ignora a RLS), tudo o que a conta guarda. Uma conta nova de uma tabela de
// `privado` precisa de uma linha aqui: os testes de cobertura falham enquanto ela faltar.
export async function semearConta(
  env: Record<string, string>,
  conta: Conta,
  terreno: Pick<Terreno, "estudos" | "trilha">,
  opcoes: { admin?: boolean } = {},
): Promise<void> {
  await comoDono(env, async (c) => {
    const { id, email, marcador, sessaoId } = conta;
    await c.query(`insert into auth."user" (id, email, role) values ($1, $2, $3)`, [
      id,
      email,
      opcoes.admin ? "admin" : "estudante",
    ]);
    await c.query(
      `insert into admin.convite (email_norm, estado, aceito_em) values ($1, 'aceito', now())`,
      [email],
    );
    // privado.*
    await c.query(
      `insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, $2, $3)`,
      [id, terreno.estudos[0], `corpo ${marcador}`],
    );
    await c.query(
      `insert into privado.anotacao_escritor (estudante_id, montagem, seq) values ($1, gen_random_uuid(), 1)`,
      [id],
    );
    await c.query(
      `insert into privado.consentimento (estudante_id, versao_aviso, texto_hash) values ($1, '1', $2)`,
      [id, hash(marcador)],
    );
    await c.query(
      `insert into privado.posicao (estudante_id, trilha_id, estudo_id) values ($1, $2, $3)`,
      [id, terreno.trilha, terreno.estudos[0]],
    );
    await c.query(
      `insert into privado.conclusao (estudante_id, estudo_id, volta) values ($1, $2, 1), ($1, $3, 1)`,
      [id, terreno.estudos[0], terreno.estudos[1]],
    );
    await c.query(`insert into privado.volta_leitura (estudante_id, volta_atual) values ($1, 2)`, [
      id,
    ]);
    await c.query(
      `insert into privado.sessao (estudante_id, check_in_em, check_out_em, estudo_inicio_id, estudo_fim_id, anotacao)
       values ($1, now() - interval '1 hour', now(), $2, $3, $4)`,
      [id, terreno.estudos[0], terreno.estudos[1], `sessão ${marcador}`],
    );
    // biblioteca de entrada e segundo fator
    await c.query(
      `insert into auth.session (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
      [sessaoId, id, `token-${marcador}`],
    );
    await c.query(
      `insert into auth.account (account_id, provider_id, user_id) values ($1, 'credential', $2)`,
      [marcador, id],
    );
    await c.query(
      `insert into auth.two_factor (secret, backup_codes, user_id) values ($1, $2, $3)`,
      [`segredo-${marcador}`, `codigos-${marcador}`, id],
    );
    await c.query(`insert into admin.segundo_fator_geracao (user_id, geracao) values ($1, 1)`, [
      id,
    ]);
    await c.query(`insert into admin.sessao_mfa (session_id) values ($1)`, [sessaoId]);
    await c.query(`insert into admin.falha_segundo_fator (session_id, falhas) values ($1, 1)`, [
      sessaoId,
    ]);
    // sem vínculo por chave estrangeira: verificações pelo endereço e contadores pelo resumo
    await c.query(
      `insert into auth.verification (identifier, value, expires_at) values
         ($1, 'otp', now() + interval '10 minutes'),
         ($2, 'otp', now() + interval '10 minutes'),
         ($3, $4, now() + interval '15 minutes')`,
      [
        `sign-in-otp-${email}`,
        `email-verification-otp-${email}`,
        `hash-${marcador}`,
        JSON.stringify({ type: "magic-link", email }),
      ],
    );
    for (const chave of chavesDeLimiteDaConta(email, id)) {
      await c.query(
        `insert into admin.tentativa (chave, janela_inicio, contagem) values ($1, now(), 1)`,
        [chave],
      );
    }
  });
}

export async function criarTerreno(): Promise<Terreno> {
  const { banco, env } = await criarBancoPreparado();
  const rodada = randomUUID();
  const trilha = `trilha-${rodada.slice(0, 8)}`;
  const estudos: [string, string] = [randomUUID(), randomUUID()];
  await comoCarga(env, async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, 9, 'x')",
      [trilha, `Trilha ${rodada}`],
    );
    for (const [i, id] of estudos.entries()) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [id, `estudo-${i}-${rodada}`, trilha, i + 1, `Título ${i} ${rodada}`, hash(rodada)],
      );
    }
  });
  const nova = (prefixo: string): Conta => {
    const id = randomUUID();
    return {
      id,
      email: `${prefixo}-${id.slice(0, 8)}@convite.example`,
      marcador: `MARCADOR-${prefixo.toUpperCase()}-${id}`,
      sessaoId: randomUUID(),
    };
  };
  const a = nova("a");
  const b = nova("b");
  const terreno = { estudos, trilha };
  await semearConta(env, a, terreno);
  await semearConta(env, b, terreno);
  const convidadoPorA = `convidado-${rodada.slice(0, 8)}@convite.example`;
  await comoDono(env, (c) =>
    c.query(
      `insert into admin.convite (email_norm, estado, criado_por) values ($1, 'pendente', $2)`,
      [convidadoPorA, a.id],
    ),
  );
  return { banco, env, estudos, trilha, a, b, convidadoPorA };
}

// ───────────── o que o catálogo diz que a conta toca ─────────────

export type ColunaDeConta = { tabela: string; coluna: string; acao: string; alvo: string };

// Toda coluna, em qualquer tabela dos esquemas do aplicativo, que referencia `auth.user` (diretamente)
// ou `auth.session`. `acao`: c = cascata, n = set null.
export async function colunasLigadasAConta(env: Record<string, string>): Promise<ColunaDeConta[]> {
  return comoDono(env, async (c) => {
    const r = await c.query<ColunaDeConta>(`
      select k.conrelid::regclass::text as tabela, a.attname as coluna, k.confdeltype as acao,
             k.confrelid::regclass::text as alvo
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
      where k.contype = 'f'
        and k.confrelid in ('auth."user"'::regclass, 'auth.session'::regclass)
      order by 1, 2`);
    return r.rows;
  });
}

export async function tabelasDoCatalogo(
  env: Record<string, string>,
  esquema: string,
): Promise<string[]> {
  return comoDono(env, async (c) => {
    const r = await c.query<{ nome: string }>(
      `select c.relname as nome from pg_class c
       where c.relnamespace = $1::regnamespace and c.relkind in ('r', 'p') order by 1`,
      [esquema],
    );
    return r.rows.map((l) => l.nome);
  });
}

// Quantas linhas a conta tem em cada tabela ligada a ela (por coluna) e em cada tabela de `privado`.
export async function contagemDaConta(
  env: Record<string, string>,
  conta: Conta,
): Promise<Record<string, number>> {
  const ligadas = await colunasLigadasAConta(env);
  return comoDono(env, async (c) => {
    const saida: Record<string, number> = {};
    for (const l of ligadas) {
      // Tabelas que apontam para `auth.session` contam pelas sessões da conta.
      const r =
        l.alvo === "auth.session"
          ? await c.query<{ n: number }>(
              `select count(*)::int as n from ${l.tabela} t where t.${l.coluna} in (select id from auth.session where user_id = $1)`,
              [conta.id],
            )
          : await c.query<{ n: number }>(
              `select count(*)::int as n from ${l.tabela} t where t.${l.coluna} = $1`,
              [conta.id],
            );
      saida[`${l.tabela}.${l.coluna}`] = r.rows[0]?.n ?? 0;
    }
    const sem = await c.query<{ n: number }>(
      `select (select count(*) from admin.convite where email_norm = $1)::int
            + (select count(*) from auth.verification where identifier = any ($2) or (value like '{"type":"magic-link"%' and value::jsonb ->> 'email' = $1))::int as n`,
      [conta.email, [`sign-in-otp-${conta.email}`, `email-verification-otp-${conta.email}`]],
    );
    saida["sem-vinculo: convite e verificações"] = sem.rows[0]?.n ?? 0;
    const chaves = chavesDeLimiteDaConta(conta.email, conta.id);
    const t = await c.query<{ n: number }>(
      "select count(*)::int as n from admin.tentativa where chave = any ($1)",
      [chaves],
    );
    saida["sem-vinculo: admin.tentativa"] = t.rows[0]?.n ?? 0;
    return saida;
  });
}
