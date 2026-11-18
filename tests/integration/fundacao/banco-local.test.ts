import pg from "pg";
import { describe, expect, inject, it } from "vitest";

describe.skipIf(inject("alvoBanco") === "neon")("banco local de execução", () => {
  it("responde e é Postgres 17", async () => {
    const cliente = new pg.Client({ connectionString: inject("urlBancoExecucao") });
    await cliente.connect();
    try {
      const um = await cliente.query("select 1 as um");
      expect(um.rows[0]?.um).toBe(1);
      const versao = await cliente.query("show server_version");
      expect(String(versao.rows[0]?.server_version).startsWith("17")).toBe(true);
    } finally {
      await cliente.end();
    }
  });
});
