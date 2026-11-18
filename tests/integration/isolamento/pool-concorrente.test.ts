import { randomUUID } from "node:crypto";
import { count, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { criarCliente, obterDb, obterPool } from "@/db/cliente";
import { fabricarComEstudante } from "@/db/com-estudante";
import { anotacao, usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Pool de tamanho 1: toda transação, de qualquer conta, passa pela MESMA conexão física.
// É o pior caso do agrupador: se a identidade vazasse de uma transação para a próxima, apareceria aqui.

const rodada = randomUUID();
const contas = Array.from({ length: 4 }, () => randomUUID());
const cliente = (() => {
  aplicarEnvDeTeste();
  return criarCliente({ max: 1 });
})();
const comEstudante1 = fabricarComEstudante(() => cliente.db);

beforeAll(async () => {
  await obterDb()
    .insert(usuario)
    .values(contas.map((id, i) => ({ id, email: `c${i}-${rodada}@example.test` })));
});

afterAll(async () => {
  await obterDb().delete(usuario).where(inArray(usuario.id, contas));
  await cliente.pool.end();
  await obterPool().end();
});

describe("identidade por transação em conexão agrupada de tamanho 1", () => {
  it("transações concorrentes de contas diferentes não vazam identidade", async () => {
    const pids = new Set<number>();
    const resultados = await Promise.all(
      contas.flatMap((id, i) =>
        [0, 1, 2].map((rodadaN) =>
          comEstudante1(id, async (tx) => {
            const estudo = randomUUID();
            const marcador = `MARCADOR-${i}-${rodadaN}-${rodada}`;
            await tx
              .insert(anotacao)
              .values({ estudanteId: id, estudoId: estudo, corpo: marcador });
            await tx.execute(sql`select pg_sleep(0.05)`);
            const [pid] = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows as {
              pid: number;
            }[];
            pids.add(Number(pid?.pid));
            const visiveis = await tx
              .select({ corpo: anotacao.corpo, dono: anotacao.estudanteId })
              .from(anotacao);
            return { id, marcador, visiveis };
          }),
        ),
      ),
    );
    for (const r of resultados) {
      // Cada transação vê só as linhas da própria conta (3 por conta ao final; no mínimo a sua)...
      expect(r.visiveis.length).toBeGreaterThanOrEqual(1);
      for (const linha of r.visiveis) expect(linha.dono).toBe(r.id);
      // ...e vê a que acabou de gravar (controle positivo).
      expect(r.visiveis.map((l) => l.corpo)).toContain(r.marcador);
    }
    // Controle (só no banco local, sem agrupador no meio): uma só conexão física atendeu tudo.
    if (inject("alvoBanco") === "local") expect(pids.size).toBe(1);
  });

  it("depois do COMMIT nada fica visível sem nova identidade", async () => {
    // Mesma conexão física, fora de transação com identidade.
    const resto = await cliente.pool.query(
      "select current_setting('app.estudante_id', true) as ident, (select count(*)::int from privado.anotacao) as n",
    );
    expect(resto.rows[0]?.ident ?? "").toBe("");
    expect(resto.rows[0]?.n).toBe(0);
    // Controle: com identidade as linhas existem (12 gravadas, 3 por conta).
    const dela = await comEstudante1(contas[0] as string, (tx) =>
      tx.select({ n: count() }).from(anotacao),
    );
    expect(dela[0]?.n).toBe(3);
  });
});
