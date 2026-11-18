import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSUNTO_ENTRADA,
  enviarEmail,
  escaparHtml,
  modeloConvite,
  modeloEntrada,
} from "@/lib/email";

const URL_CONFIRMAR = "https://site.example/entrar/confirmar?token=abc123";

describe("modeloEntrada", () => {
  const modelo = modeloEntrada({
    para: "pessoa@convite.example",
    urlConfirmar: URL_CONFIRMAR,
    codigo: "123456",
  });

  it("traz o link da nossa página e o código, em texto e em HTML", () => {
    expect(modelo.assunto).toBe(ASSUNTO_ENTRADA);
    expect(modelo.texto).toContain(URL_CONFIRMAR);
    expect(modelo.texto).toContain("123456");
    expect(modelo.html).toContain(URL_CONFIRMAR);
    expect(modelo.html).toContain("123456");
  });

  it("nunca traz o caminho da biblioteca que consome o link no GET", () => {
    expect(modelo.texto).not.toContain("/api/auth/magic-link/verify");
    expect(modelo.html).not.toContain("/api/auth/magic-link/verify");
    expect(modelo.texto).not.toContain("/api/auth");
  });

  it("escapa o HTML dos valores (controle: o texto puro não é alterado)", () => {
    const malicioso = modeloEntrada({
      para: "pessoa@convite.example",
      urlConfirmar: 'https://site.example/entrar/confirmar?token="><script>x</script>',
      codigo: "<b>1</b>",
    });
    expect(malicioso.html).not.toContain("<script>");
    expect(malicioso.html).not.toContain("<b>1</b>");
    expect(malicioso.html).toContain("&lt;script&gt;");
    expect(malicioso.texto).toContain("<script>");
  });
});

describe("modeloConvite", () => {
  it("traz o endereço do site e nenhum link de entrada", () => {
    const modelo = modeloConvite({
      para: "pessoa@convite.example",
      urlEntrar: "https://site.example/entrar",
    });
    expect(modelo.texto).toContain("https://site.example/entrar");
    expect(modelo.texto).toContain("Enviar acesso");
    expect(modelo.texto).not.toContain("confirmar");
    expect(modelo.texto).not.toContain("token");
    expect(modelo.html).not.toContain("confirmar");
  });
});

describe("escaparHtml", () => {
  it("troca os cinco caracteres perigosos", () => {
    expect(escaparHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });
});

describe("enviarEmail com transporte em arquivo", () => {
  const pastas: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
  });

  it("grava um JSON por mensagem e o nome não traz o endereço", async () => {
    const pasta = mkdtempSync(join(tmpdir(), "jnf-correio-"));
    pastas.push(pasta);
    vi.stubEnv("MAIL_TRANSPORT", "arquivo");
    vi.stubEnv("MAIL_DIR", pasta);
    const modelo = modeloConvite({
      para: "pessoa@convite.example",
      urlEntrar: "https://site.example/entrar",
    });
    expect(await enviarEmail(modelo)).toBe(true);
    const arquivos = readdirSync(pasta);
    expect(arquivos).toHaveLength(1);
    expect(arquivos[0]).not.toContain("pessoa");
    const lido = JSON.parse(readFileSync(join(pasta, arquivos[0] as string), "utf8"));
    expect(lido.para).toBe("pessoa@convite.example");
  });

  it("a falha vai ao registro só com o código, nunca com o conteúdo", async () => {
    vi.stubEnv("MAIL_TRANSPORT", "arquivo");
    vi.stubEnv("MAIL_DIR", "/proc/nao-existe/correio");
    const erros: string[] = [];
    const espiao = vi.spyOn(console, "error").mockImplementation((...args) => {
      erros.push(args.join(" "));
    });
    const resultado = await enviarEmail({
      para: "pessoa@convite.example",
      assunto: "x",
      texto: "SEGREDO-NO-CORPO 654321",
      html: "<p>SEGREDO-NO-CORPO</p>",
    });
    espiao.mockRestore();
    expect(resultado).toBe(false);
    expect(erros.length).toBeGreaterThan(0);
    expect(erros.join("\n")).not.toContain("SEGREDO-NO-CORPO");
    expect(erros.join("\n")).not.toContain("pessoa@convite.example");
  });
});
