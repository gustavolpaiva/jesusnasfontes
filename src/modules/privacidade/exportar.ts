import { eq, sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { convite } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";

// Exportar todos os dados do Estudante (PRIV-03). As tabelas vêm do CATÁLOGO do banco, não de uma lista
// escrita à mão: toda tabela do esquema `privado` com `estudante_id` entra sozinha, inclusive as que
// planos futuros criarem. Cada uma é lida por `comEstudante` (RLS forçada), numa só transação, então o
// arquivo é uma foto consistente. Nenhum dado de outra pessoa pode chegar aqui: a política `dono` filtra.

type Porta = typeof comEstudante;

export type TabelaPrivada = { nome: string; colunas: string[] };

export type DadosExportados = {
  geradoEm: string;
  versaoFormato: 1;
  perfil: { email: string; criadaEm: string | null };
  convite: { estado: string; criadoEm: string | null; aceitoEm: string | null } | null;
  tabelas: Record<string, Record<string, unknown>[]>;
};

// Colunas de cada tabela de `privado`, sem as geradas (como o `tsv` da busca, que não é dado da pessoa).
// Uma tabela de `privado` SEM `estudante_id` quebraria o isolamento: falha em vez de ser omitida.
export async function listarTabelasPrivadas(tx: Tx): Promise<TabelaPrivada[]> {
  const r = await tx.execute<{ tabela: string; colunas: string[]; tem_dono: boolean }>(sql`
    select c.relname as tabela,
           array_agg(a.attname::text order by a.attnum) filter (where a.attgenerated = '') as colunas,
           bool_or(a.attname = 'estudante_id') as tem_dono
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'privado'::regnamespace and c.relkind in ('r', 'p')
    group by c.oid, c.relname
    order by c.relname`);
  const semDono = r.rows.filter((l) => !l.tem_dono).map((l) => l.tabela);
  if (semDono.length > 0) {
    throw new Error(`Tabela de privado sem estudante_id: ${semDono.join(", ")}`);
  }
  return r.rows.map((l) => ({ nome: l.tabela, colunas: l.colunas }));
}

const iso = (valor: Date | string | null | undefined): string | null =>
  valor ? new Date(valor).toISOString() : null;

export async function exportarDados(
  estudanteId: string,
  { porta = comEstudante, agora = () => new Date() }: { porta?: Porta; agora?: () => Date } = {},
): Promise<DadosExportados> {
  const [conta] = await obterDb()
    .select({ email: usuario.email, criadaEm: usuario.createdAt })
    .from(usuario)
    .where(eq(usuario.id, estudanteId));
  if (!conta) throw new Error("Conta inexistente.");
  const [conv] = await obterDb()
    .select({ estado: convite.estado, criadoEm: convite.criadoEm, aceitoEm: convite.aceitoEm })
    .from(convite)
    .where(eq(convite.emailNorm, conta.email));

  const tabelas = await porta(estudanteId, async (tx) => {
    const saida: Record<string, Record<string, unknown>[]> = {};
    for (const t of await listarTabelasPrivadas(tx)) {
      const colunas = sql.join(
        t.colunas.map((c) => sql.identifier(c)),
        sql`, `,
      );
      const linhas = await tx.execute<Record<string, unknown>>(
        sql`select ${colunas} from ${sql.identifier("privado")}.${sql.identifier(t.nome)}
            where ${sql.identifier("estudante_id")} = ${estudanteId}::uuid`,
      );
      saida[t.nome] = linhas.rows;
    }
    return saida;
  });

  return {
    geradoEm: agora().toISOString(),
    versaoFormato: 1,
    perfil: { email: conta.email, criadaEm: iso(conta.criadaEm) },
    convite: conv
      ? { estado: conv.estado, criadoEm: iso(conv.criadoEm), aceitoEm: iso(conv.aceitoEm) }
      : null,
    tabelas,
  };
}
