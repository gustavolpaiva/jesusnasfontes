import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { obterDb, obterPool } from "../../src/db/cliente";
import { registrarErro } from "../../src/lib/registro";
import {
  chaveDaCriacaoDoSegundoFator,
  chaveSegundoFatorDaConta,
} from "../../src/modules/identidade/limite";
import { normalizarEmail } from "../../src/modules/identidade/normalizar-email";

// Recuperação do segundo fator, feita por quem administra o banco (a pessoa perdeu o aparelho e os
// códigos). Duas etapas, e nenhuma delas escreve a partir de uma busca:
//
//   pnpm exec tsx scripts/admin/recuperar-segundo-fator.ts --variavel ADMIN_EMAIL_INICIAL
//     PRÉVIA (padrão), somente leitura: acha a conta pelo endereço (exige EXATAMENTE uma), imprime
//     o id dela e quanto seria removido. Não escreve nada: a transação abre como "read only".
//
//   ... --variavel ADMIN_EMAIL_INICIAL --executar --id <uuid-da-previa>
//     ESCRITA: o id precisa ser o que a busca devolve para o endereço NESTA execução. Dentro da
//     transação a linha da conta é travada, relida por id, e as contagens do que seria apagado são
//     conferidas contra tetos fixos ANTES de qualquer exclusão. Toda exclusão é pelo id da conta
//     (ou pelas duas chaves de limite derivadas dele), nunca pelo endereço nem por predicado mais
//     largo.
//
// Só conta de Admin: é a única que tem segundo fator neste produto; qualquer outro papel é recusado.
// Nunca imprime o endereço; ele vem de uma variável de ambiente. O banco alvo é o do ambiente.

export type ResultadoRecuperacao = { codigo: 0 | 2; mensagem: string };

// Tetos. Um Admin entra por link, uma sessão por entrada, e cada sessão vale por dias: 50 é muito
// mais do que qualquer uso real e muito menos do que "a tabela inteira". Acima disso, aborta.
export const TETO_DE_SESSOES = 50;
const TETO_DE_LINHAS_DE_SEGUNDO_FATOR = 1;
const CHAVES_DE_LIMITE = 2;

const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Conta = { id: string; email: string; role: string };

const recusa = (mensagem: string): ResultadoRecuperacao => ({ codigo: 2, mensagem });

function chavesDeLimite(id: string): string[] {
  return [chaveSegundoFatorDaConta(id), chaveDaCriacaoDoSegundoFator(id)];
}

export async function recuperarSegundoFator(
  emailBruto: string,
  opcoes: { executar?: boolean; id?: string } = {},
): Promise<ResultadoRecuperacao> {
  const email = normalizarEmail(emailBruto);
  const executar = opcoes.executar === true;
  if (executar && !opcoes.id) {
    return recusa("IdObrigatorio: --executar exige --id <uuid> (rode a prévia para ver o id).");
  }
  if (opcoes.id !== undefined && !FORMATO_UUID.test(opcoes.id)) {
    return recusa("IdInvalido: --id precisa ser um UUID.");
  }
  const db = obterDb();
  return db.transaction(
    async (tx): Promise<ResultadoRecuperacao> => {
      // Busca por endereço: só LEITURA, e só serve para conferir o id. Cardinalidade exata.
      const achadas = (
        await tx.execute<Conta>(
          sql`select id::text as id, email, role from auth."user" where email = ${email} limit 2`,
        )
      ).rows;
      if (achadas.length === 0) {
        return recusa("ContaInexistente: nenhuma conta com esse endereço.");
      }
      if (achadas.length > 1) {
        return recusa("ContaAmbigua: mais de uma conta com esse endereço; nada foi alterado.");
      }
      const alvo = achadas[0] as Conta;
      if (alvo.role !== "admin") {
        return recusa("ContaNaoAdmin: só a conta de Admin tem segundo fator; nada foi alterado.");
      }
      const chaves = chavesDeLimite(alvo.id);
      const contagens = async () => {
        const lido = await tx.execute<{ fatores: number; sessoes: number; limites: number }>(sql`
          select
            (select count(*) from auth.two_factor where user_id = ${alvo.id})::int as fatores,
            (select count(*) from auth.session where user_id = ${alvo.id})::int as sessoes,
            (select count(*) from admin.tentativa where chave in (${chaves[0]}, ${chaves[1]}))::int as limites`);
        return lido.rows[0] as { fatores: number; sessoes: number; limites: number };
      };

      if (!executar) {
        // Cinto e suspensório: a prévia só segue se o banco confirma que a transação é somente leitura.
        const modo = (
          await tx.execute<{ m: string }>(sql`select current_setting('transaction_read_only') as m`)
        ).rows[0]?.m;
        if (modo !== "on") return recusa("PreviaNaoSomenteLeitura: abortada; nada foi alterado.");
        const c = await contagens();
        const ativo = (
          await tx.execute<{ ativo: boolean }>(
            sql`select two_factor_enabled as ativo from auth."user" where id = ${alvo.id}`,
          )
        ).rows[0]?.ativo;
        return {
          codigo: 0,
          mensagem: [
            "PRÉVIA (nada foi escrito)",
            `id: ${alvo.id}`,
            `papel: ${alvo.role}`,
            `segundo fator ativo: ${ativo === true ? "sim" : "não"}`,
            `seriam removidos: linhas de segundo fator ${c.fatores}, sessões ${c.sessoes}, linhas de limite ${c.limites}`,
            `para executar: repita o comando com --executar --id ${alvo.id}`,
          ].join("\n"),
        };
      }

      // ESCRITA. O id informado precisa ser o da busca desta execução.
      if (opcoes.id?.toLowerCase() !== alvo.id.toLowerCase()) {
        return recusa(
          "IdDiferente: o id informado não é o da conta deste endereço; nada foi alterado.",
        );
      }
      // Trava a linha da conta e a relê por id: daqui até o fim da transação ninguém muda a conta.
      const travada = (
        await tx.execute<Conta>(
          sql`select id::text as id, email, role from auth."user" where id = ${alvo.id} for update`,
        )
      ).rows;
      if (travada.length !== 1 || travada[0]?.email !== email || travada[0]?.role !== "admin") {
        return recusa("ContaMudou: a conta não confere mais com o endereço; nada foi alterado.");
      }
      const c = await contagens();
      if (
        c.fatores > TETO_DE_LINHAS_DE_SEGUNDO_FATOR ||
        c.sessoes > TETO_DE_SESSOES ||
        c.limites > CHAVES_DE_LIMITE
      ) {
        return recusa(
          `TetoExcedido: o que seria removido passa do esperado (segundo fator ${c.fatores}, sessões ${c.sessoes}, limites ${c.limites}); nada foi alterado.`,
        );
      }
      const fatores = await tx.execute(
        sql`delete from auth.two_factor where user_id = ${alvo.id} returning id`,
      );
      await tx.execute(
        sql`update auth."user" set two_factor_enabled = false where id = ${alvo.id}`,
      );
      // A geração sobe na MESMA transação que apaga: qualquer conferência que começou antes e termina
      // depois perde a comparação e não concede nada (ver `concederSegundoFator`).
      await tx.execute(sql`
        insert into admin.segundo_fator_geracao (user_id, geracao) values (${alvo.id}, 1)
        on conflict (user_id) do update set geracao = admin.segundo_fator_geracao.geracao + 1`);
      const sessoes = await tx.execute(
        sql`delete from auth.session where user_id = ${alvo.id} returning id`,
      );
      // Os tetos do segundo fator antigo não devem prender o cadastro novo (as chaves guardam só um resumo).
      const limites = await tx.execute(
        sql`delete from admin.tentativa where chave in (${chaves[0]}, ${chaves[1]}) returning chave`,
      );
      return {
        codigo: 0,
        mensagem: `segundo fator removido (linhas: ${fatores.rows.length}, sessões encerradas: ${sessoes.rows.length}, linhas de limite: ${limites.rows.length}); a próxima entrada pede novo cadastro`,
      };
    },
    // Na prévia a transação nem PODE escrever: o banco recusa qualquer escrita (25006).
    { accessMode: executar ? "read write" : "read only" },
  );
}

function lerVariavel(argumentos: string[]): string | null {
  const i = argumentos.indexOf("--variavel");
  const nome = i >= 0 ? argumentos[i + 1] : undefined;
  if (!nome || !/^[A-Z][A-Z0-9_]*$/.test(nome)) return null;
  return process.env[nome] ?? null;
}

function lerId(argumentos: string[]): string | undefined {
  const i = argumentos.indexOf("--id");
  return i >= 0 ? argumentos[i + 1] : undefined;
}

async function principal(): Promise<number> {
  const argumentos = process.argv.slice(2);
  const email = lerVariavel(argumentos);
  if (!email) {
    console.error(
      "Uso: --variavel NOME_DA_VARIAVEL [--executar --id UUID] (a variável precisa estar definida).",
    );
    return 2;
  }
  const r = await recuperarSegundoFator(email, {
    executar: argumentos.includes("--executar"),
    id: lerId(argumentos),
  });
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
