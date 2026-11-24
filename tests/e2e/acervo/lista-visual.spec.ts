import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Conferência RENDERIZADA da lista do Acervo e da navegação de quatro itens (plano 02-03; rule
// `visual-verification-gate`). Roda só quando `VISUAL_DIR` aponta para a pasta das capturas e das medições
// (e então roda nas larguras e temas dos projetos `varredura-*`); sem ela, é pulado. O critério está escrito
// antes de olhar, em `.planning/phases/02-acervo/visual/03-lista.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/lista-visual.spec.ts --project=varredura-320-claro ...

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");

type Linha = { criterio: string; ok: boolean; medida: string };

function luminancia(rgb: [number, number, number]): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}
// Com `filter: grayscale(1)` o navegador troca cada cor pelo seu brilho (pesos Rec. 709 sobre o valor sRGB).
function emCinza(rgb: [number, number, number]): [number, number, number] {
  const g = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [g, g, g];
}
function contrasteEmCinza(a: [number, number, number], b: [number, number, number]): number {
  const [la, lb] = [luminancia(emCinza(a)), luminancia(emCinza(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function lerRgb(css: string): [number, number, number] {
  const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(css);
  if (!m) throw new Error(`cor ilegível: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function definirEscala(page: Page, passo: 1 | 5): Promise<void> {
  const baseURL = test.info().project.use.baseURL ?? "http://localhost";
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: String(passo), url: baseURL as string }]);
}

// Linhas de texto de um elemento: um retângulo por linha do texto.
const linhasDoTexto = (page: Page, seletor: string) =>
  page.locator(seletor).evaluateAll((els) =>
    els.map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return {
        texto: (el.textContent ?? "").trim(),
        linhas: new Set(Array.from(r.getClientRects()).map((c) => Math.round(c.top))).size,
        cortado: el.scrollWidth > el.clientWidth + 1,
      };
    }),
  );

for (const passo of [1, 5] as const) {
  test(`@varredura lista do Acervo, passo ${passo} do texto`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const nome = `${info.project.name}-passo${passo}`;
    const largura = page.viewportSize()?.width ?? 0;
    const resultado: Linha[] = [];
    const registrar = (criterio: string, ok: boolean, medida: string) =>
      resultado.push({ criterio, ok, medida });

    const email = emailDeTeste(`visual-${nome}`);
    await convidarParaTeste(email);
    await entrarPorLink(page, email);
    await definirEscala(page, passo);
    await page.goto("/acervo");
    await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();
    mkdirSync(PASTA as string, { recursive: true });

    // (a) quatro itens da faixa em uma linha cada, sem corte. Controle positivo logo abaixo.
    const faixa = "nav[aria-label='Seções']:visible a";
    const itens = await linhasDoTexto(page, faixa);
    const naturais = await page.locator(faixa).evaluateAll((els) =>
      els.map((el) => {
        const c = document.createElement("span");
        c.style.cssText = "position:absolute;white-space:nowrap;visibility:hidden";
        c.className = el.className;
        c.textContent = el.textContent;
        document.body.append(c);
        const w = Math.ceil(c.getBoundingClientRect().width);
        c.remove();
        return `${el.textContent}:${w}/${Math.round(el.getBoundingClientRect().width)}`;
      }),
    );
    registrar(
      "a: largura natural do texto / largura do item (informativo)",
      true,
      naturais.join(" "),
    );
    registrar(
      "a: faixa com quatro itens (cabeçalho em 1280 px tem um a mais só para Admin)",
      itens.length === 4,
      itens.map((i) => i.texto).join(" | "),
    );
    registrar(
      "a: cada rótulo em uma única linha e sem corte",
      itens.every((i) => i.linhas === 1 && !i.cortado),
      itens.map((i) => `${i.texto}:${i.linhas}l${i.cortado ? ":cortado" : ""}`).join(" "),
    );
    const controleQuebra = await page.evaluate(() => {
      const d = document.createElement("div");
      d.className = "text-label";
      d.style.cssText = "width:24px;overflow-wrap:anywhere;position:absolute;left:0;top:0";
      d.textContent = "Caderno";
      document.body.append(d);
      const r = document.createRange();
      r.selectNodeContents(d);
      const n = new Set(Array.from(r.getClientRects()).map((c) => Math.round(c.top))).size;
      d.remove();
      return n;
    });
    registrar(
      "a: controle positivo, o medidor acusa quebra em coluna estreita",
      controleQuebra > 1,
      `${controleQuebra} linhas`,
    );

    // (b) sem rolagem horizontal
    const sobra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    registrar("b: sem rolagem horizontal", sobra <= 0, `sobra ${sobra}px`);

    // (d) alvos e linhas
    const alturas = await page.evaluate(() => {
      const h = (s: string) =>
        Array.from(document.querySelectorAll(s)).map((e) =>
          Math.round(e.getBoundingClientRect().height),
        );
      return {
        filtro: h('[data-slot="filtro-nivel-item"]'),
        linhas: h('[data-slot="linha-fonte"]'),
        faixa: h("nav[aria-label='Seções'] a").filter((v) => v > 0),
        menu: h('button[aria-label="Abrir menu"]'),
      };
    });
    registrar(
      "d: itens do filtro >= 44 px",
      alturas.filtro.every((v) => v >= 44),
      alturas.filtro.join(","),
    );
    registrar(
      "d: linhas >= 64 px",
      alturas.linhas.every((v) => v >= 64),
      alturas.linhas.join(","),
    );
    registrar(
      "d: itens da faixa >= 44 px",
      alturas.faixa.every((v) => v >= 44),
      alturas.faixa.join(","),
    );
    registrar(
      "d: botão de Menu >= 44 px",
      alturas.menu.every((v) => v >= 44),
      alturas.menu.join(","),
    );

    // (e) nenhum Nível vazio oferecido
    const contagens = await page
      .locator('[data-slot="filtro-nivel-item"]')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
    const comNumero = contagens.filter((t) => /\(\d+\)/.test(t));
    registrar(
      "e: todo item de filtro de Nível tem contagem > 0",
      comNumero.length > 0 && comNumero.every((t) => Number(/\((\d+)\)/.exec(t)?.[1]) > 0),
      contagens.join(" | "),
    );
    const gruposVazios = await page
      .locator('[data-slot="grupo-nivel"]')
      .evaluateAll(
        (els) =>
          els.filter((e) => e.querySelectorAll('[data-slot="linha-fonte"]').length === 0).length,
      );
    registrar("e: nenhum grupo sem linha", gruposVazios === 0, `${gruposVazios} grupos vazios`);

    // (f) foco: Tab na ordem visual, contorno >= 2 px (inclui o pseudo-elemento da linha inteira)
    const passos: { nome: string; topo: number; esq: number; contorno: number; pseudo: number }[] =
      [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("Tab");
      passos.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const r = el.getBoundingClientRect();
          const css = getComputedStyle(el);
          const ps = getComputedStyle(el, "::after");
          return {
            nome: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30),
            topo: Math.round(r.top + window.scrollY),
            esq: Math.round(r.left),
            contorno: css.outlineStyle === "none" ? 0 : Number.parseFloat(css.outlineWidth),
            pseudo: ps.outlineStyle === "none" ? 0 : Number.parseFloat(ps.outlineWidth),
          };
        }),
      );
    }
    const ordem = passos.every((p, i) => {
      const a = passos[i - 1];
      return !a || p.topo > a.topo - 2 || (Math.abs(p.topo - a.topo) <= 2 && p.esq >= a.esq - 2);
    });
    registrar(
      "f: Tab segue a ordem visual (topo e esquerda não regridem)",
      ordem,
      passos.map((p) => `${p.nome}@${p.topo}`).join(" > "),
    );
    registrar(
      "f: todo foco com contorno >= 2 px (no elemento ou, na linha, no pseudo-elemento)",
      passos.every((p) => Math.max(p.contorno, p.pseudo) >= 2),
      passos.map((p) => `${Math.max(p.contorno, p.pseudo)}`).join(","),
    );

    // Captura em cor
    await page.keyboard.press("Home");
    await page.screenshot({
      path: path.join(PASTA as string, `03-lista-${nome}.png`),
      fullPage: true,
    });

    // Filtro selecionado e (c) cinza
    await page.goto("/acervo?nivel=primaria");
    await expect(
      page.locator('[data-slot="filtro-nivel-item"][aria-current="true"]'),
    ).toBeVisible();
    const cores = await page.evaluate(() => {
      const sel = document.querySelector(
        '[data-slot="filtro-nivel-item"][aria-current="true"]',
      ) as HTMLElement;
      const nao = document.querySelector(
        '[data-slot="filtro-nivel-item"]:not([aria-current])',
      ) as HTMLElement;
      const a = getComputedStyle(sel);
      const b = getComputedStyle(nao);
      return {
        selFundo: a.backgroundColor,
        selTexto: a.color,
        naoFundo: b.backgroundColor,
        naoTexto: b.color,
        naoBorda: b.borderTopColor,
        pagina: getComputedStyle(document.body).backgroundColor,
        icone: sel.querySelectorAll("svg").length,
      };
    });
    const cSel = contrasteEmCinza(lerRgb(cores.selFundo), lerRgb(cores.selTexto));
    const cNao = contrasteEmCinza(lerRgb(cores.pagina), lerRgb(cores.naoTexto));
    const cBordaNao = contrasteEmCinza(lerRgb(cores.pagina), lerRgb(cores.naoBorda));
    // Controle positivo: vermelho e verde de mesmo brilho se confundem em cinza.
    const controle = contrasteEmCinza([200, 60, 60], [20, 117, 20]);
    registrar(
      "c: selecionado em cinza, contraste fundo/texto >= 4,5 e ícone check presente",
      cSel >= 4.5 && cores.icone === 1,
      `${cSel.toFixed(2)}:1, ${cores.icone} ícone`,
    );
    registrar(
      "c: não selecionado em cinza, texto legível e contorno distinto do papel (>= 1,5)",
      cNao >= 4.5 && cBordaNao >= 1.5,
      `texto ${cNao.toFixed(2)}:1, contorno ${cBordaNao.toFixed(2)}:1`,
    );
    registrar(
      "c: controle positivo, o medidor acusa par de mesmo brilho",
      controle < 1.1,
      `${controle.toFixed(2)}:1`,
    );
    await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
    await page.screenshot({
      path: path.join(PASTA as string, `03-lista-${nome}-cinza.png`),
      fullPage: false,
    });

    // (d) a linha inteira é clicável (primeiro clique, canto direito e baixo, longe do título)
    await page.goto("/acervo");
    const linha = page.locator('[data-slot="linha-fonte"]').first();
    const caixa = await linha.boundingBox();
    await linha.click({ position: { x: (caixa?.width ?? 8) - 4, y: (caixa?.height ?? 8) - 6 } });
    await expect(page).toHaveURL(/\/acervo\/[^/?#]+$/);
    registrar(
      "d: clique no canto da linha abre a Fonte (primeiro clique)",
      true,
      page.url().replace(/^.*\/acervo/, "/acervo"),
    );

    writeFileSync(
      path.join(PASTA as string, `03-lista-${nome}.json`),
      JSON.stringify({ projeto: info.project.name, largura, passo, resultado }, null, 2),
    );
    const falhas = resultado.filter((r) => !r.ok);
    expect(falhas, JSON.stringify(falhas, null, 2)).toEqual([]);
  });
}

test("@varredura Menu do Admin: bloco Administração e link do cabeçalho", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const largura = page.viewportSize()?.width ?? 0;
  const resultado: Linha[] = [];
  await entrarComoAdmin(page, `visual-${info.project.name}`);
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  const cabecalho = await page
    .getByRole("link", { name: "Administração" })
    .filter({ visible: true })
    .count();
  resultado.push({
    criterio: "link Administração no cabeçalho só a partir de 1024 px",
    ok: largura >= 1024 ? cabecalho === 1 : cabecalho === 0,
    medida: `${cabecalho} visível em ${largura}px`,
  });
  await page.getByRole("button", { name: "Abrir menu" }).click();
  const folha = page.getByRole("dialog", { name: "Menu" });
  const link = folha
    .locator('[data-slot="menu-administracao"]')
    .getByRole("link", { name: "Convites" });
  await expect(link).toBeVisible();
  const h = Math.round((await link.boundingBox())?.height ?? 0);
  resultado.push({ criterio: "link Convites do Menu >= 44 px", ok: h >= 44, medida: `${h}px` });
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.finish();
  });
  await page.screenshot({
    path: path.join(PASTA as string, `03-menu-admin-${info.project.name}.png`),
  });
  writeFileSync(
    path.join(PASTA as string, `03-menu-admin-${info.project.name}.json`),
    JSON.stringify({ projeto: info.project.name, largura, resultado }, null, 2),
  );
  expect(resultado.filter((r) => !r.ok)).toEqual([]);
});
