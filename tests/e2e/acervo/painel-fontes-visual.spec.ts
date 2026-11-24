import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { slugDoTitulo } from "../../../src/modules/acervo/schemas-painel";
import { cargarFonteDoArquivo, removerFonteDeTeste } from "../../support/fonte-painel-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import { escrever } from "../../support/login-e2e";

// Conferência RENDERIZADA do painel de Fontes (plano 02-17; rule `visual-verification-gate`). Roda só com `VISUAL_DIR`
// (pasta das capturas e das medições). O critério (a a i) está escrito ANTES de olhar, em
// `.planning/phases/02-acervo/visual/17-painel-fontes.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/painel-fontes-visual.spec.ts

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });

type Linha = { criterio: string; ok: boolean; medida: string };

async function definirEscala(page: Page, passo: 1 | 5): Promise<void> {
  const baseURL = test.info().project.use.baseURL ?? "http://localhost";
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: String(passo), url: baseURL as string }]);
}

const sobraHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Alvos de toque pequenos dentro de `main`: altura < 44 (largura < 44 para checkbox e radio). */
function alvosPequenos(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pequenos: string[] = [];
    const seletor =
      'main a[href], main button, main input:not([type="hidden"]), main textarea, main [role="checkbox"], main [role="radio"]';
    for (const el of document.querySelectorAll<HTMLElement>(seletor)) {
      if (el.getAttribute("aria-hidden") === "true" || el.tabIndex === -1) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const papel = el.getAttribute("role");
      const quadrado = papel === "checkbox" || papel === "radio";
      // O link de um texto corrido não conta: aqui não há nenhum; todo `a` é botão ou linha.
      if (r.height < 43.5 || (quadrado && r.width < 43.5))
        pequenos.push(
          `${el.tagName.toLowerCase()}:${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}:${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return pequenos;
  });
}

type Chip = { texto: string; estilo: string; largura: number; icone: boolean };
function lerChips(page: Page): Promise<Chip[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="chip-estado"]')].map((el) => {
      const c = getComputedStyle(el);
      return {
        texto: (el.textContent ?? "").trim(),
        estilo: c.borderTopStyle,
        largura: Number.parseFloat(c.borderTopWidth),
        icone: el.querySelector("svg") !== null,
      };
    }),
  );
}

function luminanciaDe(rgb: number[]): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}
function lerRgb(css: string): number[] {
  const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(css);
  if (!m) throw new Error(`cor ilegível: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function contrasteEmCinza(a: number[], b: number[]): number {
  const cinza = (x: number[]) => {
    const g = 0.2126 * (x[0] ?? 0) + 0.7152 * (x[1] ?? 0) + 0.0722 * (x[2] ?? 0);
    return luminanciaDe([g, g, g]);
  };
  const [la, lb] = [cinza(a), cinza(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const criadas: string[] = [];
test.afterAll(async () => {
  for (const slug of criadas) await removerFonteDeTeste(slug);
});

for (const [passo, variante] of [
  [1, "projeto"],
  [5, "projeto"],
  [1, "390-claro"],
  [5, "390-claro"],
] as const) {
  test(`@varredura painel de Fontes, passo ${passo} do texto${variante === "projeto" ? "" : ` (${variante})`}`, async ({
    page,
  }, info) => {
    test.setTimeout(300_000);
    if (variante === "390-claro") {
      test.skip(info.project.name !== "varredura-390-escuro", "variante só no projeto de 390 px");
      await page.emulateMedia({ colorScheme: "light" });
    }
    const nome = `${variante === "390-claro" ? "varredura-390-claro" : info.project.name}-passo${passo}`;
    const largura = page.viewportSize()?.width ?? 0;
    const resultado: Linha[] = [];
    const registrar = (criterio: string, ok: boolean, medida: string) =>
      resultado.push({ criterio, ok, medida });
    mkdirSync(PASTA as string, { recursive: true });
    const foto = (arquivo: string, cheia = true) =>
      page.screenshot({
        path: path.join(PASTA as string, `17-${arquivo}-${nome}.png`),
        fullPage: cheia,
      });
    const cinza = async (arquivo: string) => {
      await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
      await foto(`${arquivo}-cinza`, false);
      await page.evaluate(() => {
        for (const s of document.querySelectorAll("style")) {
          if (s.textContent === "html{filter:grayscale(1)}") s.remove();
        }
      });
    };

    // ── Semeadura: uma Fonte do arquivo em conflito (origem LONGA) e uma Fonte do painel publicada ──
    const slugArquivo = `vis17-${nome}`;
    const slugPainel = `vis17p-${nome}`;
    criadas.push(slugArquivo, slugPainel);
    const origemLonga = `https://exemplo.invalid/${"a-muito-longa-".repeat(16)}fim`;
    await cargarFonteDoArquivo(slugArquivo, false, (f) => ({ ...f, origem_url: origemLonga }));
    await escrever("update acervo.fonte set limites_pt = $2 where slug = $1", [
      slugArquivo,
      "Limites editados no painel para a conferência.",
    ]);
    await cargarFonteDoArquivo(slugArquivo, false, (f) => ({ ...f, origem_url: origemLonga }));
    await escrever(
      `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_url, publicada, origem_registro)
       values ($1, $2, 'primaria', 'integral', 'pt', 'dp-declarado-pela-origem', 'https://exemplo.invalid/p', true, 'painel')`,
      [slugPainel, `Obra do painel ${nome}`],
    );

    await entrarComoAdmin(page, `visual-pf-${nome}`);
    await definirEscala(page, passo);
    const erros: string[] = [];
    page.on("pageerror", (e) => erros.push(e.message));

    // ── Controles positivos dos medidores ──
    await page.goto("/admin/acervo/fontes");
    await expect(page.getByRole("heading", { level: 1, name: "Fontes" })).toBeVisible();
    const estouro = await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "controle-estouro";
      d.style.cssText = "width:max-content;overflow-wrap:normal;white-space:nowrap";
      d.textContent = "x".repeat(400);
      document.querySelector("main")?.appendChild(d);
      const sobra = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      d.remove();
      return sobra;
    });
    registrar(
      "controle c: o medidor de estouro vê um estouro provocado",
      estouro > 0,
      `${estouro}px`,
    );
    expect(estouro).toBeGreaterThan(0);
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "controle-pequeno";
      b.textContent = "pequeno";
      b.style.cssText = "height:30px;width:80px";
      document.querySelector("main")?.appendChild(b);
    });
    const pequeno = await alvosPequenos(page);
    await page.evaluate(() => document.getElementById("controle-pequeno")?.remove());
    registrar(
      "controle f: o medidor de alvos reprova um botão de 30 px",
      pequeno.length > 0,
      pequeno.join(" | "),
    );
    expect(pequeno.length).toBeGreaterThan(0);

    // ── Lista: (e) chips, (f) alvos, (g) rolagem ──
    await page.goto("/admin/acervo/fontes");
    await expect(page.getByRole("heading", { level: 1, name: "Fontes" })).toBeVisible();
    await expect(page.getByText("Em conflito com a carga").first()).toBeVisible();
    const chips = await lerChips(page);
    const por = (t: string) => chips.find((c) => c.texto === t);
    const trio = [por("Publicada"), por("Não publicada"), por("Em conflito com a carga")];
    const assinaturas = trio.map((c) => (c ? `${c.estilo}|${c.largura}|${c.icone}` : "ausente"));
    registrar(
      "e: chips distintos em cinza (estilo, largura, ícone) e com texto",
      !assinaturas.includes("ausente") && new Set(assinaturas).size === 3,
      assinaturas.join("  /  "),
    );
    expect(assinaturas).not.toContain("ausente");
    expect(new Set(assinaturas).size).toBe(3);
    const sobraLista = await sobraHorizontal(page);
    const pequenosLista = await alvosPequenos(page);
    registrar("g: lista sem rolagem horizontal", sobraLista <= 0, `${sobraLista}px`);
    registrar(
      "f: lista com alvos de 44 px",
      pequenosLista.length === 0,
      pequenosLista.join(" | ") || "todos ≥ 44",
    );
    await foto("lista");
    await cinza("lista");

    // ── Formulário novo: (h) botão nunca desabilitado, (a) ACER-09, (i) primeiro clique ──
    await page.goto("/admin/acervo/fontes/novo");
    const salvar = page.getByRole("button", { name: "Salvar Fonte" });
    await esperarHidratado(salvar);
    const desabilitado = () =>
      salvar.evaluate(
        (b) => (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true",
      );
    const dVazio = await desabilitado();
    const titulo = `Visual ${nome}`;
    criadas.push(slugDoTitulo(titulo));
    await page.getByLabel("Título", { exact: true }).fill(titulo);
    await page.getByLabel("Origem do texto (endereço https)").fill(origemLonga);
    await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
    await page.getByRole("checkbox", { name: "Obra protegida" }).click();
    const dPreenchido = await desabilitado();
    const sobraForm = await sobraHorizontal(page);
    const pequenosForm = await alvosPequenos(page);
    await foto("formulario");
    await salvar.click(); // o PRIMEIRO clique depois da hidratação
    const mensagem = page.getByText(/Obra protegida não pode ter texto integral/);
    await expect(mensagem).toBeVisible();
    const medidaErro = await page.evaluate(() => {
      const c = document.getElementById("campo-obra_protegida");
      const erro = document.getElementById("erro-obra_protegida");
      const campo = c?.closest('[data-slot="field"]');
      const r = erro?.getBoundingClientRect();
      return {
        foco: document.activeElement === c,
        invalido: c?.getAttribute("aria-invalid") === "true",
        dentroDoCampo: Boolean(campo && erro && campo.contains(erro)),
        visivel: Boolean(r && r.top >= 0 && r.bottom <= window.innerHeight),
      };
    });
    registrar(
      "a: ACER-09 no campo, foco movido, aria-invalid e visível",
      Object.values(medidaErro).every(Boolean),
      JSON.stringify(medidaErro),
    );
    expect(medidaErro).toEqual({ foco: true, invalido: true, dentroDoCampo: true, visivel: true });
    registrar(
      "i: primeiro clique em Salvar Fonte mostra o erro",
      true,
      "visível sem segundo clique",
    );
    const dErro = await desabilitado();
    registrar(
      "h: Salvar Fonte nunca desabilitado (vazio, preenchido, depois de erro)",
      !dVazio && !dPreenchido && !dErro,
      `${dVazio}/${dPreenchido}/${dErro}`,
    );
    expect(dVazio || dPreenchido || dErro).toBe(false);
    registrar("g: formulário sem rolagem horizontal", sobraForm <= 0, `${sobraForm}px`);
    registrar(
      "f: formulário com alvos de 44 px",
      pequenosForm.length === 0,
      pequenosForm.join(" | ") || "todos ≥ 44",
    );
    await foto("formulario-erro-acer09", false);
    await cinza("formulario-erro-acer09");
    // Controle positivo do (a): sem a marca, a mesma Fonte salva.
    await page.getByRole("checkbox", { name: "Obra protegida" }).click();
    await salvar.click();
    await expect(page).toHaveURL(/\?salvo=1/);
    registrar(
      "controle a: sem a marca de protegida o formulário salva",
      true,
      page.url().split("?")[1] ?? "",
    );

    // ── Fonte do arquivo com conflito: (b), (c), (d), (i) ──
    await page.goto(`/admin/acervo/fontes/${slugArquivo}`);
    const aviso = page.locator('[data-slot="aviso-de-conflito"]');
    await expect(aviso).toBeVisible();
    const medidaAviso = await page.evaluate(() => {
      const alerta = document.querySelector<HTMLElement>(
        '[data-slot="aviso-de-conflito"] [role="status"]',
      );
      if (!alerta) return null;
      const c = getComputedStyle(alerta);
      const corpo = getComputedStyle(document.body).backgroundColor;
      return {
        filete: c.borderLeftColor,
        fundo: corpo,
        palavra: alerta.textContent?.includes("Atenção.") ?? false,
        icone: alerta.querySelector("svg") !== null,
        cita: alerta.textContent?.includes("O que esta Fonte não pode dizer") ?? false,
      };
    });
    const contraste = medidaAviso
      ? contrasteEmCinza(lerRgb(medidaAviso.filete), lerRgb(medidaAviso.fundo))
      : 0;
    registrar(
      "b: conflito visível, cita o campo, palavra e ícone, filete ≥ 3:1 em cinza",
      Boolean(medidaAviso?.palavra && medidaAviso.icone && medidaAviso.cita) && contraste >= 3,
      `${JSON.stringify(medidaAviso)} contraste em cinza ${contraste.toFixed(2)}`,
    );
    expect(medidaAviso?.palavra && medidaAviso.icone && medidaAviso.cita).toBeTruthy();
    expect(contraste).toBeGreaterThanOrEqual(3);

    const medidaOrigem = await page.evaluate(() => {
      const dd = [...document.querySelectorAll<HTMLElement>("dd")].find((d) =>
        d.textContent?.includes("a-muito-longa-"),
      );
      const coluna = document.querySelector("main")?.getBoundingClientRect();
      const r = dd?.getBoundingClientRect();
      return {
        sobra: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cabe: Boolean(r && coluna && r.right <= coluna.right + 1),
        achou: Boolean(dd),
      };
    });
    registrar(
      "c: endereço de origem longo quebra sem estourar",
      medidaOrigem.achou && medidaOrigem.sobra <= 0 && medidaOrigem.cabe,
      JSON.stringify(medidaOrigem),
    );
    expect(medidaOrigem).toMatchObject({ achou: true, cabe: true });
    expect(medidaOrigem.sobra).toBeLessThanOrEqual(0);

    const pequenosArquivo = await alvosPequenos(page);
    registrar(
      "f: Fonte do arquivo com alvos de 44 px",
      pequenosArquivo.length === 0,
      pequenosArquivo.join(" | ") || "todos ≥ 44",
    );
    registrar(
      "g: Fonte do arquivo sem rolagem horizontal",
      medidaOrigem.sobra <= 0,
      `${medidaOrigem.sobra}px`,
    );
    await foto("fonte-do-arquivo-conflito");
    await cinza("fonte-do-arquivo-conflito");

    const abrir = aviso.getByRole("button", { name: "Reverter ao arquivo" });
    await esperarHidratado(abrir);
    await abrir.click(); // PRIMEIRO clique
    const dialogo = page.getByRole("alertdialog");
    await expect(dialogo).toBeVisible();
    const focoInicial = await page.evaluate(() => document.activeElement?.textContent?.trim());
    await foto("dialogo-reverter", false);
    await cinza("dialogo-reverter");
    await page.keyboard.press("Escape");
    await expect(dialogo).toHaveCount(0);
    const focoVolta = await abrir.evaluate((el) => el === document.activeElement);
    registrar(
      "d: diálogo com foco inicial em Cancelar e Esc devolve o foco",
      focoInicial === "Cancelar" && focoVolta,
      `inicial "${focoInicial}", volta ${focoVolta}`,
    );
    expect(focoInicial).toBe("Cancelar");
    expect(focoVolta).toBe(true);
    registrar(
      "i: primeiro clique em Reverter ao arquivo abre o diálogo",
      true,
      "aberto sem segundo clique",
    );

    // ── Resumo da seção ──
    await page.goto(`/admin/acervo/fontes/${slugArquivo}/secoes/18`);
    await expect(page.getByRole("heading", { level: 1, name: "Livro 18" })).toBeVisible();
    await esperarHidratado(page.getByRole("button", { name: "Salvar resumo" }));
    const sobraSecao = await sobraHorizontal(page);
    const pequenosSecao = await alvosPequenos(page);
    registrar("g: resumo da seção sem rolagem horizontal", sobraSecao <= 0, `${sobraSecao}px`);
    registrar(
      "f: resumo da seção com alvos de 44 px",
      pequenosSecao.length === 0,
      pequenosSecao.join(" | ") || "todos ≥ 44",
    );
    await foto("resumo-da-secao");

    // ── Formulário com seções (Fonte do painel) ──
    await page.goto(`/admin/acervo/fontes/${slugDoTitulo(titulo)}`);
    await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));
    await page.getByRole("button", { name: "Adicionar seção" }).click();
    const sobraSecoes = await sobraHorizontal(page);
    const pequenosSecoes = await alvosPequenos(page);
    registrar(
      "g: formulário com seção sem rolagem horizontal",
      sobraSecoes <= 0,
      `${sobraSecoes}px`,
    );
    registrar(
      "f: formulário com seção com alvos de 44 px",
      pequenosSecoes.length === 0,
      pequenosSecoes.join(" | ") || "todos ≥ 44",
    );
    await foto("formulario-com-secao");

    writeFileSync(
      path.join(PASTA as string, `17-painel-fontes-${nome}.json`),
      `${JSON.stringify({ nome, largura, passo, resultado, erros }, null, 2)}\n`,
    );
    expect(erros).toEqual([]);
    const falhas = resultado.filter((l) => !l.ok);
    expect(falhas, JSON.stringify(falhas)).toEqual([]);
  });
}
