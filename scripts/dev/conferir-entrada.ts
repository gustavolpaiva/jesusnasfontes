import { pathToFileURL } from "node:url";
import type pg from "pg";
import { obterPool } from "../../src/db/cliente";
import { registrarErro } from "../../src/lib/registro";
import { lerEmail, normalizarEmail } from "../../src/modules/identidade/normalizar-email";

// pnpm exec tsx scripts/dev/conferir-entrada.ts --desde <instante ISO>   (confere a entrada real)
// pnpm exec tsx scripts/dev/conferir-entrada.ts --totais                 (totais do banco, antes e depois)
//
// Imprime SÓ contagens e fatos booleanos, uma linha `chave=valor` por medida: nunca um endereço, um
// token, um segredo ou um código. As duas contas vêm das variáveis de ambiente ADMIN_EMAIL_INICIAL
// (o Admin) e JNF_CANARIO_ESTUDANTE_EMAIL (o Estudante canário), lidas por nome.
//
// SOMENTE LEITURA: tudo corre numa transação `READ ONLY`, sempre desfeita no fim. A posição de leitura
// (privado.posicao) está sob RLS forçada, então cada conta é lida com a identidade dela (`set_config`
// local à transação), como o aplicativo faz: o script não usa o dono do banco.
//
// Recusa rodar se o marcador `acervo.ambiente` do banco não for 'dev'.
//
// Saída: 0 = as contagens são as que a entrada real deve deixar · 1 = alguma diverge (a linha
// `DIVERGE <chave>` diz qual) · 2 = não foi possível medir (variável ausente, banco inacessível,
// ambiente que não é dev).

export type ContaMedida = {
  existe: boolean;
  sessoesNovas: number;
  // Posições de leitura da conta; null se a tabela ainda não existe (migração 0008 não aplicada).
  posicoes: number | null;
  verificacoesRestantes: number;
};

export type MedicaoDeEntrada = {
  admin: ContaMedida & {
    // Sessões novas do Admin que têm a linha de segundo fator verificado (admin.sessao_mfa).
    sessoesComSegundoFator: number;
    // O fato gravado: o segundo fator da geração atual já foi concedido ao menos uma vez.
    segundoFatorConcedido: boolean;
  };
  estudante: ContaMedida;
};

export class NaoMedido extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "NaoMedido";
  }
}

type Cliente = Pick<pg.PoolClient, "query">;

async function posicoesDe(c: Cliente, id: string): Promise<number | null> {
  const existe = await c.query("select to_regclass('privado.posicao') is not null as ok");
  if (!existe.rows[0]?.ok) return null;
  await c.query("select set_config('app.estudante_id', $1, true)", [id]);
  const r = await c.query("select count(*)::int as n from privado.posicao");
  return (r.rows[0]?.n as number | undefined) ?? 0;
}

async function medirConta(
  c: Cliente,
  email: string,
  desde: Date,
): Promise<ContaMedida & { id?: string }> {
  const conta = await c.query('select id from auth."user" where email = $1', [email]);
  const id = conta.rows[0]?.id as string | undefined;
  if (!id) return { existe: false, sessoesNovas: 0, posicoes: 0, verificacoesRestantes: 0 };
  const sessoes = await c.query(
    "select count(*)::int as n from auth.session where user_id = $1 and created_at >= $2",
    [id, desde],
  );
  // Código de 6 dígitos (identificador) e link (valor JSON com o endereço). O `case` evita converter
  // para JSON um valor que não é do formato do link.
  const verificacoes = await c.query(
    `select count(*)::int as n from auth.verification
     where identifier = $1
        or (case when value like '{"type":"magic-link"%' then value::jsonb ->> 'email' end) = $2`,
    [`sign-in-otp-${email}`, email],
  );
  return {
    id,
    existe: true,
    sessoesNovas: (sessoes.rows[0]?.n as number) ?? 0,
    posicoes: await posicoesDe(c, id),
    verificacoesRestantes: (verificacoes.rows[0]?.n as number) ?? 0,
  };
}

export async function conferirAmbienteDev(c: Cliente): Promise<void> {
  const r = await c.query("select nome from acervo.ambiente");
  if (r.rows.length !== 1) throw new NaoMedido("Marcador de ambiente ausente no banco.");
  if (r.rows[0]?.nome !== "dev") throw new NaoMedido("RecusaDeAmbiente: o banco não é o de dev.");
}

// Mede dentro da transação somente leitura que o chamador abriu.
export async function medirEntrada(
  c: Cliente,
  p: { desde: Date; emailAdmin: string; emailEstudante: string },
): Promise<MedicaoDeEntrada> {
  await conferirAmbienteDev(c);
  const admin = await medirConta(c, normalizarEmail(p.emailAdmin), p.desde);
  const estudante = await medirConta(c, normalizarEmail(p.emailEstudante), p.desde);
  let sessoesComSegundoFator = 0;
  let segundoFatorConcedido = false;
  if (admin.id) {
    const mfa = await c.query(
      `select count(*)::int as n from auth.session s
       join admin.sessao_mfa m on m.session_id = s.id
       where s.user_id = $1 and s.created_at >= $2`,
      [admin.id, p.desde],
    );
    sessoesComSegundoFator = (mfa.rows[0]?.n as number) ?? 0;
    const fato = await c.query(
      "select 1 from admin.segundo_fator_geracao where user_id = $1 and concedido_em is not null",
      [admin.id],
    );
    segundoFatorConcedido = fato.rows.length > 0;
  }
  const { id: _a, ...soAdmin } = admin;
  const { id: _e, ...soEstudante } = estudante;
  return {
    admin: { ...soAdmin, sessoesComSegundoFator, segundoFatorConcedido },
    estudante: soEstudante,
  };
}

// O que a entrada real (Tarefa 3) deve deixar. Devolve as chaves que divergem; vazio = tudo certo.
export function divergencias(m: MedicaoDeEntrada): string[] {
  const falhas: string[] = [];
  const quer = (chave: string, ok: boolean) => {
    if (!ok) falhas.push(chave);
  };
  quer("admin.existe", m.admin.existe);
  quer("estudante.existe", m.estudante.existe);
  quer("admin.sessoes_novas>=1", m.admin.sessoesNovas >= 1);
  quer("estudante.sessoes_novas>=1", m.estudante.sessoesNovas >= 1);
  quer("admin.sessoes_com_segundo_fator>=1", m.admin.sessoesComSegundoFator >= 1);
  quer("admin.segundo_fator_concedido", m.admin.segundoFatorConcedido);
  quer("admin.posicoes>=1", (m.admin.posicoes ?? 0) >= 1);
  quer("estudante.posicoes=0", m.estudante.posicoes === 0);
  quer("admin.verificacoes_restantes=0", m.admin.verificacoesRestantes === 0);
  quer("estudante.verificacoes_restantes=0", m.estudante.verificacoesRestantes === 0);
  return falhas;
}

export type Totais = {
  usuarios: number;
  sessoes: number;
  segundoFatorLinhas: number;
  posicoes: number | null;
};

// Totais do banco, para conferir "antes e depois" de uma migração ou carga. A posição está sob RLS:
// soma-se conta por conta, com a identidade de cada uma.
export async function medirTotais(c: Cliente): Promise<Totais> {
  await conferirAmbienteDev(c);
  const um = async (sql: string) => ((await c.query(sql)).rows[0]?.n as number) ?? 0;
  const usuarios = await um('select count(*)::int as n from auth."user"');
  const sessoes = await um("select count(*)::int as n from auth.session");
  const segundoFatorLinhas = await um("select count(*)::int as n from auth.two_factor");
  const ids = (await c.query('select id from auth."user"')).rows.map((l) => l.id as string);
  let posicoes: number | null = 0;
  for (const id of ids) {
    const n = await posicoesDe(c, id);
    if (n === null) {
      posicoes = null;
      break;
    }
    posicoes += n;
  }
  return { usuarios, sessoes, segundoFatorLinhas, posicoes };
}

function linhas(prefixo: string, o: Record<string, number | boolean | null>): string[] {
  return Object.entries(o).map(([k, v]) => `${prefixo}.${k}=${v === null ? "tabela_ausente" : v}`);
}

export function formatar(m: MedicaoDeEntrada): string[] {
  const conta = (x: ContaMedida) => ({
    existe: x.existe,
    sessoes_novas: x.sessoesNovas,
    posicoes: x.posicoes,
    verificacoes_restantes: x.verificacoesRestantes,
  });
  return [
    ...linhas("admin", {
      ...conta(m.admin),
      sessoes_com_segundo_fator: m.admin.sessoesComSegundoFator,
      segundo_fator_concedido: m.admin.segundoFatorConcedido,
    }),
    ...linhas("estudante", conta(m.estudante)),
  ];
}

async function emSomenteLeitura<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await obterPool().connect();
  try {
    await c.query("begin read only");
    try {
      return await fn(c);
    } finally {
      await c.query("rollback");
    }
  } finally {
    c.release();
  }
}

async function principal(): Promise<number> {
  const argumentos = process.argv.slice(2);
  const modoTotais = argumentos.includes("--totais");
  const i = argumentos.indexOf("--desde");
  const desde = i >= 0 ? new Date(argumentos[i + 1] ?? "") : null;
  if (!modoTotais && (!desde || Number.isNaN(desde.getTime()))) {
    console.error("Uso: conferir-entrada --desde <instante ISO>  |  conferir-entrada --totais");
    return 2;
  }
  try {
    if (modoTotais) {
      const t = await emSomenteLeitura((c) => medirTotais(c));
      console.log(
        linhas("total", {
          usuarios: t.usuarios,
          sessoes: t.sessoes,
          segundo_fator_linhas: t.segundoFatorLinhas,
          posicoes: t.posicoes,
        }).join("\n"),
      );
      return 0;
    }
    const emailAdmin = lerEmail(process.env.ADMIN_EMAIL_INICIAL);
    const emailEstudante = lerEmail(process.env.JNF_CANARIO_ESTUDANTE_EMAIL);
    if (!emailAdmin || !emailEstudante) {
      console.error(
        "NaoMedido: ADMIN_EMAIL_INICIAL e JNF_CANARIO_ESTUDANTE_EMAIL precisam estar no ambiente",
      );
      return 2;
    }
    const m = await emSomenteLeitura((c) =>
      medirEntrada(c, { desde: desde as Date, emailAdmin, emailEstudante }),
    );
    console.log(formatar(m).join("\n"));
    const falhas = divergencias(m);
    for (const f of falhas) console.log(`DIVERGE ${f}`);
    return falhas.length === 0 ? 0 : 1;
  } catch (erro) {
    if (erro instanceof NaoMedido) {
      console.error(erro.message);
    } else {
      registrarErro("conferir-entrada", erro);
      console.error("NaoMedido: falha ao ler o banco");
    }
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().then(async (codigo) => {
    await obterPool().end();
    process.exit(codigo);
  });
}
