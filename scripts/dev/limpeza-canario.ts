import type pg from "pg";
import { conferirAmbienteDev } from "./conferir-entrada";
import { RecusaCanario } from "./protecao-canario";

// Linhas privadas de uma conta canário (plano 01-19). Uma execução só mexe numa conta canário com a trava
// (`trava-canario.ts`) na mão, a conta CHEGA vazia (pré-condição medida pelo catálogo) e o que ela tem
// ao fim é, por construção, o que esta execução escreveu. A limpeza apaga TODAS as linhas privadas da
// conta, dentro de uma transação, com teto, e confere zero ao fim.

export const TETO_POR_TABELA = 10;
export const TETO_TOTAL = 30;

export class AlvoAMais extends RecusaCanario {
  override name = "AlvoAMais";
}

type Cliente = Pick<pg.Client, "query">;

const NOME_VALIDO = /^[a-z_]+$/;

// Toda tabela de `privado` com `estudante_id`, lida do catálogo (uma tabela nova entra sozinha).
async function tabelasDaConta(c: Cliente): Promise<string[]> {
  const r = await c.query<{ tabela: string }>(
    `select table_name as tabela from information_schema.columns
     where table_schema = 'privado' and column_name = 'estudante_id' order by table_name`,
  );
  for (const { tabela } of r.rows) {
    if (!NOME_VALIDO.test(tabela)) throw new RecusaCanario("nome de tabela privada inesperado");
  }
  return r.rows.map((l) => l.tabela);
}

export type Contagem = { total: number; porTabela: Record<string, number> };

export async function contarLinhasPrivadas(c: Cliente, usuarioId: string): Promise<Contagem> {
  const porTabela: Record<string, number> = {};
  let total = 0;
  for (const tabela of await tabelasDaConta(c)) {
    const r = await c.query<{ n: number }>(
      `select count(*)::int as n from privado.${tabela} where estudante_id = $1`,
      [usuarioId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) porTabela[tabela] = n;
    total += n;
  }
  return { total, porTabela };
}

// Apaga tudo o que a conta tem em `privado`. Aborta sem escrever se passar do teto; confere zero ao fim
// (dentro da transação e de novo depois do commit). Devolve quantas linhas apagou, por tabela.
export async function limparTudo(c: Cliente, usuarioId: string): Promise<Record<string, number>> {
  await conferirAmbienteDev(c);
  await c.query("begin");
  try {
    const tabelas = await tabelasDaConta(c);
    // Travar antes de contar: nenhuma linha nova entra entre a contagem e o apagar.
    for (const tabela of tabelas) {
      await c.query(`select 1 from privado.${tabela} where estudante_id = $1 for update`, [
        usuarioId,
      ]);
    }
    const antes = await contarLinhasPrivadas(c, usuarioId);
    const maior = Math.max(0, ...Object.values(antes.porTabela));
    if (maior > TETO_POR_TABELA || antes.total > TETO_TOTAL) {
      throw new AlvoAMais(
        `AlvoAMais: ${antes.total} linhas (maior tabela ${maior}) passam do teto (${TETO_POR_TABELA} por tabela, ${TETO_TOTAL} no total); nada foi apagado`,
      );
    }
    // Filhas antes: o escritor da Anotação aponta para a Anotação.
    const ordem = Object.keys(antes.porTabela).sort((a, b) =>
      a.endsWith("_escritor") ? -1 : b.endsWith("_escritor") ? 1 : a.localeCompare(b),
    );
    for (const tabela of ordem) {
      await c.query(`delete from privado.${tabela} where estudante_id = $1`, [usuarioId]);
    }
    if ((await contarLinhasPrivadas(c, usuarioId)).total !== 0) {
      throw new AlvoAMais("sobrou linha depois de apagar; revertido");
    }
    await c.query("commit");
    return antes.porTabela;
  } catch (erro) {
    await c.query("rollback").catch(() => undefined);
    throw erro;
  }
}
