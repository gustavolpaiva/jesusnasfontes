import type pg from "pg";
import {
  chaveDaCriacaoDoSegundoFator,
  chaveSegundoFatorDaConta,
} from "../../src/modules/identidade/limite";
import { normalizarEmail } from "../../src/modules/identidade/normalizar-email";
import { type EstadoCanario, lerEstado, type Papel, type ResultadoDesabilitar } from "./canario";
import { conferirContaCanario } from "./protecao-canario";

// Escritas de habilitar e desabilitar uma conta canário, feitas NO CLIENTE que o chamador entrega: a
// `ExecucaoCanario` entrega a própria conexão que segura a trava de sessão, então escrita e trava vivem
// ou morrem juntas (queda da conexão = transação abortada, nada escrito). Cada função confere o banco dev
// e a conta nessa mesma conexão antes de escrever, e tudo roda numa transação.
//
// São as mesmas operações de `habilitar` e `desabilitar` do CLI (`canario.ts`), em SQL direto como dono
// do banco: convite pendente com o usuário e o papel (como `convidar` sem e-mail) e, para a conta de
// Admin, o zerar do segundo fator nos mesmos passos de `recuperarSegundoFator`. `escritas-canario` tem
// teste de integração que prova o estado final de cada função.

type Cliente = Pick<pg.Client, "query">;

const TETO_DE_LINHAS_DE_SEGUNDO_FATOR = 1;
const TETO_DE_SESSOES = 50;

// Dentro da transação aberta pelo chamador. Só conta com papel admin tem segundo fator.
async function zerarSegundoFatorDentro(c: Cliente, email: string): Promise<void> {
  const conta = await c.query<{ id: string; role: string }>(
    'select id::text as id, role from auth."user" where email = $1',
    [email],
  );
  const alvo = conta.rows[0];
  if (!alvo || alvo.role !== "admin") return;
  // A mesma ordem de `recuperarSegundoFator`: geração, depois usuário.
  await c.query(
    `insert into admin.segundo_fator_geracao (user_id, geracao) values ($1, 0)
     on conflict (user_id) do nothing`,
    [alvo.id],
  );
  await c.query("select geracao from admin.segundo_fator_geracao where user_id = $1 for update", [
    alvo.id,
  ]);
  await c.query('select 1 from auth."user" where id = $1 for update', [alvo.id]);
  const n = await c.query<{ fatores: number; sessoes: number }>(
    `select (select count(*) from auth.two_factor where user_id = $1)::int as fatores,
            (select count(*) from auth.session where user_id = $1)::int as sessoes`,
    [alvo.id],
  );
  const { fatores, sessoes } = n.rows[0] ?? { fatores: 0, sessoes: 0 };
  if (fatores > TETO_DE_LINHAS_DE_SEGUNDO_FATOR || sessoes > TETO_DE_SESSOES) {
    throw new Error(
      `TetoExcedido: o que seria removido passa do esperado (segundo fator ${fatores}, sessões ${sessoes}); revertido`,
    );
  }
  await c.query("delete from auth.two_factor where user_id = $1", [alvo.id]);
  await c.query('update auth."user" set two_factor_enabled = false where id = $1', [alvo.id]);
  await c.query(
    `insert into admin.segundo_fator_geracao (user_id, geracao) values ($1, 1)
     on conflict (user_id) do update
       set geracao = admin.segundo_fator_geracao.geracao + 1, concedido_em = null`,
    [alvo.id],
  );
  await c.query("delete from auth.session where user_id = $1", [alvo.id]);
  await c.query("delete from admin.tentativa where chave in ($1, $2)", [
    chaveSegundoFatorDaConta(alvo.id),
    chaveDaCriacaoDoSegundoFator(alvo.id),
  ]);
}

async function emTransacao<T>(c: Cliente, fn: () => Promise<T>): Promise<T> {
  await c.query("begin");
  try {
    const r = await fn();
    await c.query("commit");
    return r;
  } catch (erro) {
    await c.query("rollback").catch(() => undefined);
    throw erro;
  }
}

export async function habilitarNoCliente(
  c: Cliente,
  emailBruto: string,
  papel: Papel,
): Promise<{ criado: boolean; estado: EstadoCanario }> {
  const email = normalizarEmail(emailBruto);
  await conferirContaCanario(c, email, papel);
  const criado = await emTransacao(c, async () => {
    const existente = await c.query<{ estado: string }>(
      "select estado from admin.convite where email_norm = $1 for update",
      [email],
    );
    const linha = existente.rows[0];
    let novo = false;
    if (!linha) {
      await c.query("insert into admin.convite (email_norm, estado) values ($1, 'pendente')", [
        email,
      ]);
      novo = true;
    } else if (linha.estado === "revogado") {
      await c.query(
        `update admin.convite set estado = 'pendente', revogado_em = null, criado_por = null
         where email_norm = $1`,
        [email],
      );
      novo = true;
    }
    await c.query('insert into auth."user" (email, role) values ($1, $2) on conflict do nothing', [
      email,
      papel,
    ]);
    if (papel === "admin") await zerarSegundoFatorDentro(c, email);
    return novo;
  });
  return { criado, estado: await lerEstado(c, email) };
}

export async function desabilitarNoCliente(
  c: Cliente,
  emailBruto: string,
  papel: Papel,
): Promise<ResultadoDesabilitar> {
  const email = normalizarEmail(emailBruto);
  await conferirContaCanario(c, email, papel);
  const abertas = await c.query<{ token: string }>(
    `select s.token from auth.session s join auth."user" u on u.id = s.user_id
     where u.email = $1 and s.expires_at > now()`,
    [email],
  );
  const tokens = abertas.rows.map((l) => l.token);
  await emTransacao(c, async () => {
    await c.query(
      `update admin.convite set estado = 'revogado', revogado_em = now()
       where email_norm = $1 and estado <> 'revogado'`,
      [email],
    );
    await c.query(
      'delete from auth.session where user_id in (select id from auth."user" where email = $1)',
      [email],
    );
    // As verificações pendentes (código e link) do endereço, como `apagarVerificacoesDe`.
    await c.query(
      `delete from auth.verification
       where identifier = $1
          or (value like '{"type":"magic-link"%' and value::jsonb ->> 'email' = $2)`,
      [`sign-in-otp-${email}`, email],
    );
    await zerarSegundoFatorDentro(c, email);
  });
  const estado = await lerEstado(c, email);
  const aindaValidas = tokens.length
    ? Number(
        (
          await c.query<{ n: number }>(
            "select count(*)::int as n from auth.session where token = any($1::text[]) and expires_at > now()",
            [tokens],
          )
        ).rows[0]?.n ?? 0,
      )
    : 0;
  const fatores = await c.query<{ n: number }>(
    `select count(*)::int as n from auth.two_factor t join auth."user" u on u.id = t.user_id
     where u.email = $1`,
    [email],
  );
  const segundosFatores = fatores.rows[0]?.n ?? 0;
  const confirmado =
    (estado.convite === "revogado" || estado.convite === "ausente") &&
    estado.sessoes === 0 &&
    aindaValidas === 0 &&
    segundosFatores === 0 &&
    !estado.entradaPermitida;
  return { sessoesAnteriores: tokens.length, estado, segundosFatores, confirmado };
}
