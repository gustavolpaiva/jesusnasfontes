import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baixarOrigem, ErroChecksum, validarUrl } from "../../../scripts/ingest/acervo-baixar";
import type { OrigemAcervo } from "../../../scripts/ingest/acervo-origens";
import { sha256 } from "../../../scripts/ingest/fontes";

const COMMIT = "dacb04909e43dc47738828d33cc3d2b0635bc54c";
const URL_OK = `https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/${COMMIT}/data/x.xml`;
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const origem = (url = URL_OK) =>
  ({
    commit: COMMIT,
    arquivos: [{ id: "x.xml", url, slug: "x", idioma: "en" }],
  }) as unknown as OrigemAcervo;
const pasta = () => {
  const d = mkdtempSync(path.join(tmpdir(), "jnf-baixar-"));
  temporarios.push(d);
  return d;
};
const bytes = (s: string) => new TextEncoder().encode(s);

describe("baixarOrigem", () => {
  it("sha256 diferente do lock lança ErroChecksum e não grava nada em disco", async () => {
    const dir = pasta();
    const lock = { arquivos: { "o/x.xml": sha256(bytes("esperado")) } };
    await expect(
      baixarOrigem("o", origem(), lock, {
        fixar: false,
        pastaBruto: dir,
        obter: async () => bytes("adulterado"),
      }),
    ).rejects.toBeInstanceOf(ErroChecksum);
    expect(existsSync(path.join(dir, "o", "x.xml"))).toBe(false);
  });

  it("hash igual ao lock grava o arquivo", async () => {
    const dir = pasta();
    const lock = { arquivos: { "o/x.xml": sha256(bytes("certo")) } };
    const r = await baixarOrigem("o", origem(), lock, {
      fixar: false,
      pastaBruto: dir,
      obter: async () => bytes("certo"),
    });
    expect(r.resultados[0]?.fixado).toBe(false);
    expect(readFileSync(path.join(dir, "o", "x.xml"), "utf8")).toBe("certo");
  });

  it("origem fora do lock só baixa com --fixar, e o fixar devolve o lock novo sem tocar o antigo", async () => {
    const dir = pasta();
    const obter = async () => bytes("novo");
    await expect(
      baixarOrigem("o", origem(), { arquivos: {} }, { fixar: false, pastaBruto: dir, obter }),
    ).rejects.toThrow(/não fixada/);
    expect(existsSync(path.join(dir, "o", "x.xml"))).toBe(false);
    const antigo = { arquivos: {} };
    const r = await baixarOrigem("o", origem(), antigo, { fixar: true, pastaBruto: dir, obter });
    expect(r.lock.arquivos["o/x.xml"]).toBe(sha256(bytes("novo")));
    expect(antigo.arquivos).toEqual({});
  });

  it("--fixar recusa trocar um hash já gravado", async () => {
    const dir = pasta();
    const lock = { arquivos: { "o/x.xml": sha256(bytes("primeiro")) } };
    await expect(
      baixarOrigem("o", origem(), lock, {
        fixar: true,
        pastaBruto: dir,
        obter: async () => bytes("segundo"),
      }),
    ).rejects.toBeInstanceOf(ErroChecksum);
  });
});

describe("validarUrl", () => {
  it("aceita só https, host permitido e commit fixado", () => {
    expect(() => validarUrl(URL_OK, { commit: COMMIT })).not.toThrow();
    expect(() =>
      validarUrl(`http://raw.githubusercontent.com/x/${COMMIT}`, { commit: COMMIT }),
    ).toThrow();
    expect(() => validarUrl(`https://exemplo.invalid/${COMMIT}/x`, { commit: COMMIT })).toThrow(
      /host/,
    );
    expect(() =>
      validarUrl("https://raw.githubusercontent.com/x/main/x.xml", { commit: COMMIT }),
    ).toThrow(/commit/);
  });
});

describe("validarUrl: origens que não versionam por commit (Gutenberg pelo espelho, página do tradutor)", () => {
  // Nestas a origem não tem commit: o que fixa o arquivo é o sha256 do lock do bruto (`acervo:baixar --fixar`).
  const SEM_COMMIT = { commit: "0".repeat(64) };

  it("aceita o espelho gutenberg.pglaf.org e a página www.gospels.net, sem exigir o commit no endereço", () => {
    expect(() =>
      validarUrl("https://gutenberg.pglaf.org/2/8/1/2811/2811-8.txt", SEM_COMMIT),
    ).not.toThrow();
    expect(() => validarUrl("https://www.gospels.net/thomas", SEM_COMMIT)).not.toThrow();
  });

  it("o endereço principal do Gutenberg, que bloqueia automação, segue fora da lista permitida", () => {
    expect(() =>
      validarUrl("https://www.gutenberg.org/cache/epub/2811/pg2811.txt", SEM_COMMIT),
    ).toThrow(/host/);
    expect(() => validarUrl("https://gutenberg.org/files/2811/2811-8.txt", SEM_COMMIT)).toThrow(
      /host/,
    );
  });

  it("http e endereço inválido continuam recusados nos hosts novos", () => {
    expect(() =>
      validarUrl("http://gutenberg.pglaf.org/2/8/1/2811/2811-8.txt", SEM_COMMIT),
    ).toThrow();
    expect(() => validarUrl("https://www.gospels.net/thomas", SEM_COMMIT)).not.toThrow();
  });
});
