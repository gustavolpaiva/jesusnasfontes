import { pathToFileURL } from "node:url";
import type pg from "pg";
import { obterPool } from "../../src/db/cliente";
import { registrarErro } from "../../src/lib/registro";
import {
  apagarVerificacoesDe,
  ConviteDuplicado,
  convidar,
} from "../../src/modules/identidade/convite";
import { lerEmail, normalizarEmail } from "../../src/modules/identidade/normalizar-email";
import { recuperarSegundoFator } from "../admin/recuperar-segundo-fator";
import { conferirAmbienteDev, NaoMedido } from "./conferir-entrada";
import {
  conferirApagadasPeloDelete,
  conferirContaCanario,
  conferirTetoDeSessoes,
  RecusaCanario,
} from "./protecao-canario";

// pnpm exec tsx scripts/dev/canario.ts <habilitar|desabilitar|estado> [--papel estudante|admin] [--enviar]
//
// A conta canário de um papel existe só para os testes de interface e fica DESABILITADA em repouso:
// habilita-se logo antes do teste e desabilita-se logo depois, também quando o teste falha.
// O endereço vem da variável de ambiente do papel (JNF_CANARIO_ESTUDANTE_EMAIL ou
// JNF_CANARIO_ADMIN_EMAIL), lida por nome; o script imprime só estados e contagens, nunca o endereço.
//
//   habilitar    convite ativo (pendente ou aceito). Sem `--enviar` nenhum e-mail sai; com `--enviar`
//                sai o e-mail de convite (só quando o convite é criado agora).
//   desabilitar  revoga o convite, apaga as sessões abertas e as verificações pendentes, e MEDE os
//                quatro fatos: convite revogado, nenhuma sessão restante, nenhuma sessão anterior ainda
//                válida (a mesma consulta que a biblioteca de entrada faz: token existente e não vencido)
//                e entrada nova recusada (o gancho de criação de sessão exige convite ativo).
//   estado       só lê. Sai 0 se a conta está inteiramente habilitada ou inteiramente desabilitada.
//
// Recusa rodar se o marcador `acervo.ambiente` do banco não for 'dev' (em 'producao', ou sem marcador
// legível, sai com 2 antes de ler ou escrever qualquer coisa).
//
// Canário de Admin: o teste cadastra o segundo fator de novo a cada rodada, então `habilitar` e
// `desabilitar` zeram o segundo fator dele (pela mesma função do script de recuperação do dono, em
// duas etapas) e `desabilitar` mede que não sobrou linha de segundo fator.
// Saída: 0 = confirmado pela medição · 1 = a medição diz que não · 2 = não foi possível medir.

export type Papel = "estudante" | "admin";
export type EstadoConvite = "ausente" | "pendente" | "aceito" | "revogado";

export type EstadoCanario = {
  convite: EstadoConvite;
  sessoes: number;
  sessoesValidas: number;
  entradaPermitida: boolean;
};

export const VARIAVEL_DO_PAPEL: Record<Papel, string> = {
  estudante: "JNF_CANARIO_ESTUDANTE_EMAIL",
  admin: "JNF_CANARIO_ADMIN_EMAIL",
};

type Cliente = Pick<pg.Pool, "query">;

export async function lerEstado(c: Cliente, emailBruto: string): Promise<EstadoCanario> {
  const email = normalizarEmail(emailBruto);
  const convite = await c.query("select estado from admin.convite where email_norm = $1", [email]);
  const estado = (convite.rows[0]?.estado as EstadoConvite | undefined) ?? "ausente";
  const sessoes = await c.query(
    `select count(*)::int as total,
            count(*) filter (where s.expires_at > now())::int as validas
     from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1`,
    [email],
  );
  return {
    convite: estado,
    sessoes: (sessoes.rows[0]?.total as number) ?? 0,
    sessoesValidas: (sessoes.rows[0]?.validas as number) ?? 0,
    // O gancho de criação de sessão da biblioteca só deixa entrar com convite pendente ou aceito.
    entradaPermitida: estado === "pendente" || estado === "aceito",
  };
}

// Zera o segundo fator da conta de Admin canário (prévia, depois escrita com o id lido). Conta que não
// existe ou que não é Admin não tem o que zerar. Qualquer outra recusa é erro: não deixa fator velho.
async function zerarSegundoFator(emailNorm: string): Promise<void> {
  const previa = await recuperarSegundoFator(emailNorm);
  if (previa.codigo !== 0) {
    if (/^(ContaInexistente|ContaNaoAdmin)/.test(previa.mensagem)) return;
    throw new Error("A prévia da recuperação do segundo fator do canário recusou.");
  }
  const id = /^id: ([0-9a-f-]{36})$/m.exec(previa.mensagem)?.[1];
  if (!id) throw new Error("A prévia da recuperação não devolveu o id.");
  const feita = await recuperarSegundoFator(emailNorm, { executar: true, id });
  if (feita.codigo !== 0) throw new Error("A recuperação do segundo fator do canário recusou.");
}

async function segundosFatoresDe(c: Cliente, emailNorm: string): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from auth.two_factor t join auth."user" u on u.id = t.user_id where u.email = $1`,
    [emailNorm],
  );
  return (r.rows[0]?.n as number) ?? 0;
}

export async function habilitar(
  c: Cliente,
  emailBruto: string,
  papel: Papel,
  enviar: boolean,
): Promise<{ criado: boolean; estado: EstadoCanario }> {
  const email = normalizarEmail(emailBruto);
  // Antes de qualquer escrita: banco de dev, endereço marcado como canário e não é a conta real.
  await conferirContaCanario(c, email, papel);
  let criado = true;
  try {
    await convidar(email, null, { papel, enviar });
  } catch (erro) {
    if (!(erro instanceof ConviteDuplicado)) throw erro;
    criado = false;
  }
  if (papel === "admin") await zerarSegundoFator(email);
  return { criado, estado: await lerEstado(c, email) };
}

export type ResultadoDesabilitar = {
  sessoesAnteriores: number;
  estado: EstadoCanario;
  segundosFatores: number;
  confirmado: boolean;
};

export async function desabilitar(
  c: Pick<pg.Pool, "query" | "connect">,
  emailBruto: string,
  papel?: Papel,
): Promise<ResultadoDesabilitar> {
  const email = normalizarEmail(emailBruto);
  // Antes de qualquer escrita: banco de dev, endereço marcado como canário e não é a conta real.
  await conferirContaCanario(c, email, papel);
  // O teto de sessões vem antes de qualquer escrita (conferido depois do DELETE nunca dispararia).
  await conferirTetoDeSessoes(c, email);
  // Antes: os tokens das sessões abertas, só para medir depois que nenhum vale mais. Ficam em memória.
  const abertas = await c.query(
    `select s.token from auth.session s join auth."user" u on u.id = s.user_id
     where u.email = $1 and s.expires_at > now()`,
    [email],
  );
  const tokens = abertas.rows.map((l) => l.token as string);

  const tx = await c.connect();
  try {
    await tx.query("begin");
    await tx.query(
      `update admin.convite set estado = 'revogado', revogado_em = now()
       where email_norm = $1 and estado <> 'revogado'`,
      [email],
    );
    const apagadas = await tx.query(
      `delete from auth.session where user_id in (select id from auth."user" where email = $1)`,
      [email],
    );
    conferirApagadasPeloDelete(apagadas.rowCount);
    await tx.query("commit");
  } catch (erro) {
    await tx.query("rollback").catch(() => undefined);
    throw erro;
  } finally {
    tx.release();
  }
  await apagarVerificacoesDe(email);
  await zerarSegundoFator(email);

  // Depois: a medição, não o relato do que foi feito.
  const estado = await lerEstado(c, email);
  const aindaValidas = tokens.length
    ? (
        await c.query(
          "select count(*)::int as n from auth.session where token = any($1::text[]) and expires_at > now()",
          [tokens],
        )
      ).rows[0]?.n
    : 0;
  const segundosFatores = await segundosFatoresDe(c, email);
  const confirmado =
    (estado.convite === "revogado" || estado.convite === "ausente") &&
    estado.sessoes === 0 &&
    aindaValidas === 0 &&
    segundosFatores === 0 &&
    !estado.entradaPermitida;
  return { sessoesAnteriores: tokens.length, estado, segundosFatores, confirmado };
}

function imprimirEstado(e: EstadoCanario, extra: Record<string, string | number | boolean> = {}) {
  const pares: Record<string, string | number | boolean> = {
    convite: e.convite,
    sessoes: e.sessoes,
    sessoes_validas: e.sessoesValidas,
    entrada_permitida: e.entradaPermitida,
    ...extra,
  };
  console.log(
    Object.entries(pares)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
}

async function principal(): Promise<number> {
  const argumentos = process.argv.slice(2);
  const acao = argumentos[0];
  const ip = argumentos.indexOf("--papel");
  const papelBruto = ip >= 0 ? argumentos[ip + 1] : "estudante";
  if (
    (acao !== "habilitar" && acao !== "desabilitar" && acao !== "estado") ||
    (papelBruto !== "estudante" && papelBruto !== "admin")
  ) {
    console.error(
      "Uso: canario <habilitar|desabilitar|estado> [--papel estudante|admin] [--enviar]",
    );
    return 2;
  }
  const papel: Papel = papelBruto;
  const email = lerEmail(process.env[VARIAVEL_DO_PAPEL[papel]]);
  if (!email) {
    console.error(`NaoMedido: ${VARIAVEL_DO_PAPEL[papel]} não está no ambiente ou não é um e-mail`);
    return 2;
  }
  try {
    const pool = obterPool();
    await conferirAmbienteDev(pool);
    if (acao === "estado") {
      const e = await lerEstado(pool, email);
      imprimirEstado(e);
      const habilitada = e.entradaPermitida;
      const consistente = habilitada || (e.sessoes === 0 && e.sessoesValidas === 0);
      return consistente ? 0 : 1;
    }
    if (acao === "habilitar") {
      const r = await habilitar(pool, email, papel, argumentos.includes("--enviar"));
      imprimirEstado(r.estado, { convite_criado_agora: r.criado });
      return r.estado.entradaPermitida ? 0 : 1;
    }
    const r = await desabilitar(pool, email, papel);
    imprimirEstado(r.estado, {
      sessoes_anteriores: r.sessoesAnteriores,
      segundos_fatores: r.segundosFatores,
    });
    console.log(`desabilitado_confirmado=${r.confirmado}`);
    return r.confirmado ? 0 : 1;
  } catch (erro) {
    if (erro instanceof NaoMedido || erro instanceof RecusaCanario) console.error(erro.message);
    else {
      registrarErro("canario", erro);
      console.error("NaoMedido: falha ao ler ou escrever no banco");
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
