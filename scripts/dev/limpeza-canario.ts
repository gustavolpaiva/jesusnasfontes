import type pg from "pg";
import { conferirAmbienteDev } from "./conferir-entrada";
import { RecusaCanario } from "./protecao-canario";

// Limpeza do que UMA execução de teste criou na conta canário (plano 01-19). Regra: escrita destrutiva
// só no que a própria execução criou, e só depois de reler cada alvo.
//
//   1. ANTES do teste, `fotografar` registra a chave de toda linha privada que a conta já tem (as que
//      NÃO são desta execução).
//   2. DEPOIS, `limpar` abre UMA transação, trava as linhas da conta e separa as novas (chave fora da
//      fotografia). Cada alvo é conferido: pertence à conta; nas tabelas com texto (anotação e sessão)
//      carrega a marca da execução. Mais alvo que o teto (por tabela ou no total), ou alvo sem a marca:
//      ABORTA SEM ESCREVER. Só então apaga, pelas posições lidas na própria transação, e confere que
//      apagou exatamente o que planejou.
//
// Linha que a conta já tinha, ou que outra pessoa (o dono, por exemplo) criou durante o teste e que não
// leva a marca nas tabelas de texto, nunca é apagada por aqui.

export const TETO_POR_TABELA = 10;
export const TETO_TOTAL = 30;
// Tabelas cujo conteúdo é texto escrito pelo teste: o alvo só vale se carregar a marca da execução.
const COM_MARCA = new Set(["anotacao", "sessao"]);

export class AlvoAMais extends RecusaCanario {
  override name = "AlvoAMais";
}

export type Fotografia = string[]; // "tabela|chave"

type Cliente = Pick<pg.Client, "query">;

const NOME_VALIDO = /^[a-z_]+$/;

async function tabelasDaConta(c: Cliente): Promise<{ tabela: string; chaves: string[] }[]> {
  const r = await c.query<{ tabela: string }>(
    `select table_name as tabela from information_schema.columns
     where table_schema = 'privado' and column_name = 'estudante_id' order by table_name`,
  );
  const saida: { tabela: string; chaves: string[] }[] = [];
  for (const { tabela } of r.rows) {
    if (!NOME_VALIDO.test(tabela)) throw new RecusaCanario("nome de tabela privada inesperado");
    const pk = await c.query<{ coluna: string }>(
      `select a.attname as coluna from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = ('privado.' || $1)::regclass and i.indisprimary order by a.attname`,
      [tabela],
    );
    if (pk.rows.length === 0)
      throw new RecusaCanario(`a tabela privada ${tabela} não tem chave primária`);
    saida.push({ tabela, chaves: pk.rows.map((l) => l.coluna) });
  }
  return saida;
}

type Linha = { tabela: string; chave: string; posicao: string; texto: string; dono: string };

async function lerLinhas(c: Cliente, usuarioId: string, travar: boolean): Promise<Linha[]> {
  const linhas: Linha[] = [];
  for (const { tabela, chaves } of await tabelasDaConta(c)) {
    const colunas = chaves.map((k) => `'${k}', to_jsonb(t) -> '${k}'`).join(", ");
    const r = await c.query<{ posicao: string; chave: string; texto: string; dono: string }>(
      `select ctid::text as posicao, jsonb_build_object(${colunas})::text as chave,
              to_jsonb(t)::text as texto, estudante_id::text as dono
       from privado.${tabela} t where estudante_id = $1${travar ? " for update" : ""}`,
      [usuarioId],
    );
    for (const l of r.rows) linhas.push({ tabela, ...l });
  }
  return linhas;
}

export async function fotografar(c: Cliente, usuarioId: string): Promise<Fotografia> {
  await conferirAmbienteDev(c);
  return (await lerLinhas(c, usuarioId, false)).map((l) => `${l.tabela}|${l.chave}`);
}

export type Plano = { alvos: Linha[]; porTabela: Record<string, number> };

// Separa e confere os alvos. Não escreve. Lança AlvoAMais ou RecusaCanario.
export function planejar(
  linhas: Linha[],
  usuarioId: string,
  foto: Fotografia,
  marca: string,
): Plano {
  const conhecidas = new Set(foto);
  const alvos = linhas.filter((l) => !conhecidas.has(`${l.tabela}|${l.chave}`));
  const porTabela: Record<string, number> = {};
  for (const l of alvos) {
    if (l.dono !== usuarioId) throw new RecusaCanario("alvo de outra conta; nada foi apagado");
    if (COM_MARCA.has(l.tabela) && !l.texto.includes(marca)) {
      throw new RecusaCanario(
        `RecusaDeMarca: uma linha nova de ${l.tabela} não leva a marca desta execução; nada foi apagado`,
      );
    }
    porTabela[l.tabela] = (porTabela[l.tabela] ?? 0) + 1;
  }
  const maior = Math.max(0, ...Object.values(porTabela));
  if (maior > TETO_POR_TABELA || alvos.length > TETO_TOTAL) {
    throw new AlvoAMais(
      `AlvoAMais: ${alvos.length} alvos (maior tabela ${maior}) passam do teto (${TETO_POR_TABELA} por tabela, ${TETO_TOTAL} no total); nada foi apagado`,
    );
  }
  return { alvos, porTabela };
}

// Devolve quantas linhas apagou, por tabela. Tudo numa transação; aborta sem escrever se algo falha.
export async function limpar(
  c: Pick<pg.Client, "query">,
  usuarioId: string,
  foto: Fotografia,
  marca: string,
): Promise<Record<string, number>> {
  await conferirAmbienteDev(c);
  await c.query("begin");
  try {
    const plano = planejar(await lerLinhas(c, usuarioId, true), usuarioId, foto, marca);
    // Filhas antes: o escritor da Anotação aponta para a Anotação.
    const ordem = [...new Set(plano.alvos.map((a) => a.tabela))].sort((a, b) =>
      a.endsWith("_escritor") ? -1 : b.endsWith("_escritor") ? 1 : a.localeCompare(b),
    );
    for (const tabela of ordem) {
      const posicoes = plano.alvos.filter((a) => a.tabela === tabela).map((a) => a.posicao);
      const r = await c.query(
        `delete from privado.${tabela} where estudante_id = $1 and ctid = any($2::tid[])`,
        [usuarioId, posicoes],
      );
      if (r.rowCount !== posicoes.length) {
        throw new AlvoAMais(`apagou ${r.rowCount} de ${posicoes.length} em ${tabela}; revertido`);
      }
    }
    await c.query("commit");
    return plano.porTabela;
  } catch (erro) {
    await c.query("rollback").catch(() => undefined);
    throw erro;
  }
}
