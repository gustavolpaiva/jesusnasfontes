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
import {
  assegurarConexaoLocal,
  criarBancoDeExecucao,
  criarBancoPreparado,
  PORTA_BANCO_LOCAL,
  removerBancoDeExecucao,
} from "../../support/banco-local";
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

describe.skipIf(inject("alvoBanco") === "neon")("remoção de banco descartável: travas", () => {
  const existe = async (nome: string) => {
    const c = new pg.Client({
      connectionString: `postgres://postgres@127.0.0.1:${PORTA_BANCO_LOCAL}/postgres`,
    });
    await c.connect();
    try {
      return (await c.query("select 1 from pg_database where datname = $1", [nome])).rowCount === 1;
    } finally {
      await c.end();
    }
  };

  it("(a) recusa nome que casa o padrão mas não foi criado por esta execução", async () => {
    await expect(removerBancoDeExecucao("teste_1_deadbeef")).rejects.toThrow(
      /criado por esta execução/,
    );
    await expect(removerBancoDeExecucao("neondb")).rejects.toThrow(/criado por esta execução/);
  });

  it("(b) recusa conexão que não seja o contêiner local, antes de conectar", async () => {
    const banco = await criarBancoDeExecucao();
    try {
      const alvos = [
        "postgres://neondb_owner@ep-exemplo.sa-east-1.aws.invalid/neondb", // modo neon: host reservado
        `postgres://postgres@127.0.0.1.exemplo.test:${PORTA_BANCO_LOCAL}/postgres`, // prefixo enganoso
        "postgres://postgres@127.0.0.1:5432/postgres", // porta diferente da constante
        "isto não é uma url",
      ];
      for (const alvo of alvos) {
        expect(() => assegurarConexaoLocal(alvo), alvo).toThrow(/Recusado/);
        await expect(removerBancoDeExecucao(banco.nome, alvo), alvo).rejects.toThrow(/Recusado/);
      }
      expect(await existe(banco.nome)).toBe(true); // nada foi apagado
    } finally {
      await removerBancoDeExecucao(banco.nome);
    }
    expect(await existe(banco.nome)).toBe(false);
  });

  it("falha na preparação remove o banco recém-criado (nenhum teste_* órfão)", async () => {
    let visto = "";
    await expect(
      criarBancoPreparado(async (banco) => {
        visto = banco.nome;
        expect(await existe(visto)).toBe(true);
        throw new Error("falha proposital");
      }),
    ).rejects.toThrow(/falha proposital/);
    expect(visto).toMatch(/^teste_/);
    expect(await existe(visto)).toBe(false);
  });
});
