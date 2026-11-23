import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { listarTabelasPrivadas } from "@/modules/privacidade/exportar";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// SÓ LEITURA do catálogo do banco (roda também no Neon): exportar e apagar a conta cobrem TODA tabela
// que guarda algo da pessoa, e quem diz quais são é o catálogo, não uma lista escrita à mão. Tabela nova
// sem cobertura faz este teste falhar e diz o que falta.

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  await obterPool().end();
});

// Tabelas dos esquemas de dado de pessoa (`auth`, `admin`, `privado`; `acervo` e `conteudo` são conteúdo
// publicado, sem dado de pessoa) SEM chave estrangeira para a conta, com o motivo e o que as trata.
// Uma tabela nova que não tem FK para `auth.user`/`auth.session` e não está aqui falha o teste: ou ela
// ganha a FK em cascata, ou entra aqui com a decisão de quem a trata ao apagar a conta.
const SEM_VINCULO_COM_A_CONTA: Record<string, string> = {
  "admin.convite":
    "removerConta apaga a linha do endereço (criado_por é set null: convites de OUTRAS pessoas)",
  "auth.verification":
    "removerConta apaga os códigos e links do endereço, pelo identificador exato",
  "admin.tentativa": "removerConta apaga as chaves da pessoa (resumos); as por IP não têm dono",
  "auth.rate_limit": "contadores da biblioteca por chave de IP e rota; nenhum dado da pessoa",
  "admin.migracao": "livro das migrações; nenhum dado de pessoa",
};

// Colunas que apontam para a conta mas NÃO em cascata, de propósito.
// `admin.registro_verificacao.por`: quem verificou uma ficha; apagar a conta do Admin não apaga o
// histórico de verificação (o registro fica, sem o nome).
const SET_NULL_ESPERADO = new Set(["admin.convite.criado_por", "admin.registro_verificacao.por"]);

describe("catálogo: exportar e apagar a conta cobrem toda tabela", () => {
  it("exportar: as tabelas lidas são exatamente as de `privado` do catálogo, e todas têm estudante_id", async () => {
    const noCatalogo = await obterPool().query<{ nome: string }>(
      `select c.relname as nome from pg_class c
       where c.relnamespace = 'privado'::regnamespace and c.relkind in ('r', 'p') order by 1`,
    );
    const nomes = noCatalogo.rows.map((l) => l.nome);
    // Controle positivo: o catálogo enxerga as tabelas conhecidas.
    expect(nomes).toEqual(expect.arrayContaining(["anotacao", "consentimento", "posicao"]));
    const lidas = await comEstudante("00000000-0000-4000-8000-000000000000", (tx) =>
      listarTabelasPrivadas(tx),
    );
    expect(lidas.map((t) => t.nome)).toEqual(nomes);
    for (const t of lidas) expect(t.colunas, t.nome).toContain("estudante_id");
    // A coluna gerada da busca não é dado da pessoa.
    expect(lidas.find((t) => t.nome === "anotacao")?.colunas).not.toContain("tsv");
  });

  it("apagar: toda tabela dos esquemas do aplicativo tem FK em cascata para a conta, ou está na lista dos tratados à mão", async () => {
    const r = await obterPool().query<{ tabela: string; ligada: boolean }>(`
      select n.nspname || '.' || c.relname as tabela,
             exists (
               select 1 from pg_constraint k
               where k.conrelid = c.oid and k.contype = 'f'
                 and k.confrelid in ('auth."user"'::regclass, 'auth.session'::regclass)
             ) as ligada
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('auth', 'admin', 'privado') and c.relkind in ('r', 'p')
      order by 1`);
    const todas = r.rows.map((l) => l.tabela);
    // Controles positivos: enxerga tabelas de cada esquema.
    expect(todas).toEqual(
      expect.arrayContaining(["auth.user", "auth.session", "privado.anotacao", "admin.convite"]),
    );
    const semCobertura = r.rows
      .filter(
        (l) => !l.ligada && l.tabela !== "auth.user" && !(l.tabela in SEM_VINCULO_COM_A_CONTA),
      )
      .map((l) => l.tabela);
    expect(
      semCobertura,
      `tabela sem FK para a conta e sem tratamento declarado: ${semCobertura.join(", ")}`,
    ).toEqual([]);
    // E a lista dos tratados à mão não guarda nome que já não existe.
    for (const nome of Object.keys(SEM_VINCULO_COM_A_CONTA)) expect(todas, nome).toContain(nome);
  });

  it("apagar: toda FK para a conta é em cascata (set null só onde declarado)", async () => {
    const r = await obterPool().query<{ tabela: string; coluna: string; acao: string }>(`
      select k.conrelid::regclass::text as tabela, a.attname as coluna, k.confdeltype as acao
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
      where k.contype = 'f' and k.confrelid in ('auth."user"'::regclass, 'auth.session'::regclass)`);
    expect(r.rows.length).toBeGreaterThan(5);
    for (const l of r.rows) {
      const nome = `${l.tabela}.${l.coluna}`;
      if (SET_NULL_ESPERADO.has(nome)) expect(l.acao, nome).toBe("n");
      else expect(l.acao, `${nome}: ON DELETE CASCADE`).toBe("c");
    }
  });
});
