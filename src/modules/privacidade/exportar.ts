import { eq, sql } from "drizzle-orm";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { convite, sessao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { travarProgresso } from "@/modules/trilhas/consultas";

// Exportar todos os dados do Estudante (PRIV-03). As tabelas vêm do CATÁLOGO do banco, não de uma lista
// escrita à mão: toda tabela do esquema `privado` com `estudante_id` entra sozinha, inclusive as que
// planos futuros criarem. Cada uma é lida por `comEstudante` (RLS forçada), numa só transação, então o
// arquivo é uma foto consistente. Nenhum dado de outra pessoa pode chegar aqui: a política `dono` filtra.

type Porta = typeof comEstudante;

export type TabelaPrivada = { nome: string; colunas: string[] };

export type DadosExportados = {
  geradoEm: string;
  versaoFormato: 1;
  perfil: {
    email: string;
    criadaEm: string | null;
    papel: string;
    emailVerificado: boolean;
    doisFatoresAtivo: boolean;
  };
  convite: { estado: string; criadoEm: string | null; aceitoEm: string | null } | null;
  // Metadados das sessões abertas da conta (IP e navegador são dado pessoal). Nunca o token.
  sessoes: {
    criadaEm: string | null;
    atualizadaEm: string | null;
    venceEm: string | null;
    ip: string | null;
    navegador: string | null;
  }[];
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
  // Tudo numa só transação e atrás da mesma fila das escritas de progresso e do apagar a conta: quem
  // apaga a conta em outra aba espera esta leitura terminar (ou esta acha a conta já apagada e para).
  // Sem a fila, o arquivo podia trazer as Anotações e perder o resto, um estado que nunca existiu.
  const { conta, conv, sessoes, tabelas } = await porta(estudanteId, async (tx) => {
    await travarProgresso(tx, estudanteId);
    const [conta] = await tx
      .select({
        email: usuario.email,
        criadaEm: usuario.createdAt,
        papel: usuario.role,
        emailVerificado: usuario.emailVerified,
        doisFatoresAtivo: usuario.twoFactorEnabled,
      })
      .from(usuario)
      .where(eq(usuario.id, estudanteId));
    if (!conta) throw new Error("Conta inexistente.");
    const [conv] = await tx
      .select({ estado: convite.estado, criadoEm: convite.criadoEm, aceitoEm: convite.aceitoEm })
      .from(convite)
      .where(eq(convite.emailNorm, conta.email));
    // Só campos permitidos, explícitos: o token e os identificadores internos ficam de fora.
    const sessoes = await tx
      .select({
        criadaEm: sessao.createdAt,
        atualizadaEm: sessao.updatedAt,
        venceEm: sessao.expiresAt,
        ip: sessao.ipAddress,
        navegador: sessao.userAgent,
      })
      .from(sessao)
      .where(eq(sessao.userId, estudanteId))
      .orderBy(sessao.createdAt);
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
    return { conta, conv, sessoes, tabelas: saida };
  });

  return {
    geradoEm: agora().toISOString(),
    versaoFormato: 1,
    perfil: {
      email: conta.email,
      criadaEm: iso(conta.criadaEm),
      papel: conta.papel,
      emailVerificado: conta.emailVerificado,
      doisFatoresAtivo: conta.doisFatoresAtivo,
    },
    convite: conv
      ? { estado: conv.estado, criadoEm: iso(conv.criadoEm), aceitoEm: iso(conv.aceitoEm) }
      : null,
    sessoes: sessoes.map((x) => ({
      criadaEm: iso(x.criadaEm),
      atualizadaEm: iso(x.atualizadaEm),
      venceEm: iso(x.venceEm),
      ip: x.ip,
      navegador: x.navegador,
    })),
    tabelas,
  };
}
