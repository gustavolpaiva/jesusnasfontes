import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { GET } from "@/app/api/ambiente/route";
import { conferirAmbiente, decidirAmbiente } from "@/db/ambiente";
import { obterPool } from "@/db/cliente";
import { comAcervo } from "@/db/com-acervo";
import { comEstudante } from "@/db/com-estudante";
import { urlDoPapel } from "@/db/url";
import { executarMigracoes } from "../../../scripts/db/migrar";
import { criarBancoDeExecucao, removerBancoDeExecucao } from "../../support/banco-local";
import { aplicarEnvDeTeste, prepararBanco } from "../../support/preparar-banco";

beforeAll(() => aplicarEnvDeTeste());
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await obterPool().end();
});

describe("par ambiente × banco (decisão pura)", () => {
  it("o par certo passa", () => {
    expect(() => decidirAmbiente("dev", "preview")).not.toThrow();
    expect(() => decidirAmbiente("dev", "development")).not.toThrow();
    expect(() => decidirAmbiente("dev", undefined)).not.toThrow();
    expect(() => decidirAmbiente("producao", "production")).not.toThrow();
  });

  it("banco 'producao' é recusado fora da produção, e banco 'dev' na produção", () => {
    for (const v of ["preview", "development", undefined, "outro"]) {
      expect(() => decidirAmbiente("producao", v), `producao × ${v}`).toThrow();
    }
    expect(() => decidirAmbiente("dev", "production")).toThrow();
  });
});

describe("conferência no banco real da execução", () => {
  it("o marcador gravado pelo migrar é 'dev' e VERCEL_ENV=production recusa as duas portas", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await conferirAmbiente()).toBe("dev");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(conferirAmbiente()).rejects.toThrow(/Ambiente recusado/);
    await expect(comAcervo(async () => 1)).rejects.toThrow(/Ambiente recusado/);
    await expect(comEstudante(crypto.randomUUID(), async () => 1)).rejects.toThrow(
      /Ambiente recusado/,
    );
  });

  it("GET /api/ambiente devolve só o rótulo, sem cache", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const resposta = await GET();
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(await resposta.json()).toEqual({ ambiente: "dev" });
  });

  it("na produção da Vercel com banco dev a rota recusa e não revela nada", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const resposta = await GET();
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toEqual({ erro: "indisponivel" });
  });
});

describe.skipIf(inject("alvoBanco") === "neon")(
  "migrar e marcador num banco 'producao' descartável",
  () => {
    it("marca 'producao', recusa 'dev' sobre ele, é idempotente e acusa checksum alterado", async () => {
      const banco = await criarBancoDeExecucao();
      const pasta = mkdtempSync(join(tmpdir(), "jnf-migracoes-"));
      try {
        const env = await prepararBanco(banco, "producao");
        const url = urlDoPapel("migra", { agrupada: false }, env);

        const lerMarcador = async () => {
          const c = new pg.Client({ connectionString: banco.url });
          await c.connect();
          try {
            return (await c.query("select nome from acervo.ambiente")).rows.map((l) => l.nome);
          } finally {
            await c.end();
          }
        };
        const marcador = await lerMarcador();
        expect(marcador).toEqual(["producao"]);
        // O marcador de produção é recusado numa pré-visualização e aceito na produção.
        expect(() => decidirAmbiente(marcador[0], "preview")).toThrow();
        expect(() => decidirAmbiente(marcador[0], "production")).not.toThrow();

        // Pedir 'dev' num banco 'producao' falha e não toca em nada.
        await expect(executarMigracoes({ url, ambiente: "dev" })).rejects.toThrow(
          /difere do pedido/,
        );
        expect(await lerMarcador()).toEqual(["producao"]);

        // Segunda execução com o ambiente certo: 0 pendentes.
        const de_novo = await executarMigracoes({ url, ambiente: "producao" });
        expect(de_novo.aplicadas).toEqual([]);
        expect(de_novo.pendentesAntes).toBe(0);

        // Arquivo já aplicado com conteúdo diferente: aborta.
        cpSync(
          join(process.cwd(), "db", "migrations", "0001_fundacao.sql"),
          join(pasta, "0001_fundacao.sql"),
        );
        const texto = readFileSync(join(pasta, "0001_fundacao.sql"), "utf8");
        writeFileSync(join(pasta, "0001_fundacao.sql"), `${texto}\n-- alterado\n`);
        await expect(executarMigracoes({ url, ambiente: "producao", pasta })).rejects.toThrow(
          /Checksum diferente/,
        );
      } finally {
        await removerBancoDeExecucao(banco.nome);
      }
    });
  },
);
