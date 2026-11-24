import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { removerExtras, type SlugsExtras, semearExtras } from "../../support/acervo-extras";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Conferência RENDERIZADA da página da Fonte e da seção (plano 02-06; rule `visual-verification-gate`). Roda só
// quando `VISUAL_DIR` aponta para a pasta das capturas e das medições, e com `E2E_ACERVO_REAL=1` (o Josefo inteiro
// no banco da execução); sem elas, é pulado. O critério (a a j) está escrito ANTES de olhar, em
// `.planning/phases/02-acervo/visual/06-fonte-secao.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> E2E_ACERVO_REAL=1 pnpm test:e2e tests/e2e/acervo/fonte-secao-visual.spec.ts --project=varredura-320-claro ...

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });

type Linha = { criterio: string; ok: boolean; medida: string };
type Rgb = [number, number, number];

function luminancia(rgb: Rgb): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}
// Com `filter: grayscale(1)` o navegador troca cada cor pelo seu brilho (pesos Rec. 709 sobre o valor sRGB).
function emCinza(rgb: Rgb): Rgb {
  const g = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [g, g, g];
}
function contrasteEmCinza(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminancia(emCinza(a)), luminancia(emCinza(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function lerRgb(css: string): Rgb {
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

const sobraHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

let sufixo = "";
let extras: SlugsExtras;
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = `vis-${info.project.name}`;
  extras = await semearExtras(sufixo);
});
test.afterAll(async () => {
  if (sufixo) await removerExtras(sufixo);
});

// O conjunto de projetos de varredura só tem 390 px no tema escuro: a variante `390-claro` roda neste mesmo projeto
// com o tema claro emulado, para o critério valer em 320, 390 e 1280 nos dois temas.
for (const [passo, variante] of [
  [1, "projeto"],
  [5, "projeto"],
  [1, "390-claro"],
  [5, "390-claro"],
] as const) {
  test(`@varredura Fonte e seção, passo ${passo} do texto${variante === "projeto" ? "" : ` (${variante})`}`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
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
        path: path.join(PASTA as string, `06-${arquivo}-${nome}.png`),
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

    const email = emailDeTeste(`visual-fs-${nome}`);
    await convidarParaTeste(email);
    await entrarPorLink(page, email);
    await definirEscala(page, passo);

    // Controles positivos dos medidores (a, i): um bloco que SABE estourar tem de ser acusado.
    await page.goto("/acervo");
    const controle = await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.cssText = "width:40px;overflow:hidden;position:absolute;left:0;top:0";
      const f = document.createElement("div");
      f.textContent = "textosemnenhumpontodequebranemmesmocomalgumaboavontade";
      f.style.cssText = "white-space:nowrap";
      d.append(f);
      document.body.append(d);
      const estoura = d.scrollWidth > d.clientWidth + 1;
      const fora = d.getBoundingClientRect().right;
      d.remove();
      return { estoura, fora };
    });
    registrar(
      "a/i: controle positivo, o medidor acusa bloco que estoura",
      controle.estoura,
      `scrollWidth > clientWidth: ${controle.estoura}`,
    );
    const par = contrasteEmCinza([200, 60, 60], [20, 117, 20]);
    registrar(
      "b/f: controle positivo, o cálculo de cinza acusa par de mesmo brilho",
      par < 1.1,
      `${par.toFixed(2)}:1`,
    );

    // ── Fonte real: (c) sumário, (i) rolagem ──
    await page.goto("/acervo/josefo-antiguidades");
    await expect(
      page.getByRole("heading", { level: 1, name: "Antiguidades Judaicas" }),
    ).toBeVisible();
    const sumario = await page.locator('[data-slot="linha-secao"]').evaluateAll((els) =>
      els.map((e) => ({
        linha: Math.round(e.getBoundingClientRect().height),
        link: Math.round((e.querySelector("a") as HTMLElement).getBoundingClientRect().height),
        cortado: e.scrollWidth > e.clientWidth + 1,
      })),
    );
    registrar(
      "c: sumário do Josefo real com 20 linhas",
      sumario.length === 20,
      `${sumario.length} linhas`,
    );
    registrar(
      "c: cada linha >= 64 px, cada link >= 44 px, nenhuma cortada",
      sumario.every((s) => s.linha >= 64 && s.link >= 44 && !s.cortado),
      `menor linha ${Math.min(...sumario.map((s) => s.linha))} px, menor link ${Math.min(...sumario.map((s) => s.link))} px`,
    );
    registrar(
      "i: Fonte real sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("fonte-josefo");

    // ── Fonte de teste traduzida: (a) endereço longo, (b) aviso acima do bloco ──
    await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}`);
    await expect(page.locator('[data-slot="bloco-proveniencia"]')).toBeVisible();
    const proveniencia = await page.evaluate(() => {
      const bloco = document.querySelector('[data-slot="bloco-proveniencia"]') as HTMLElement;
      const dds = Array.from(bloco.querySelectorAll("dd"));
      const link = bloco.querySelector(
        "a[href*='texto-integral-sem-quebra']",
      ) as HTMLElement | null;
      const aviso = Array.from(document.querySelectorAll<HTMLElement>('[role="status"]')).find(
        (e) => (e.textContent ?? "").includes("Esta tradução foi feita por nós"),
      ) as HTMLElement | undefined;
      const css = aviso ? getComputedStyle(aviso) : null;
      return {
        cortados: dds.filter((d) => d.scrollWidth > d.clientWidth + 1).length,
        linkDireita: link ? Math.round(link.getBoundingClientRect().right) : -1,
        janela: window.innerWidth,
        linkAltura: link ? Math.round(link.getBoundingClientRect().height) : 0,
        avisoFundo: aviso ? Math.round(aviso.getBoundingClientRect().bottom) : -1,
        blocoTopo: Math.round(bloco.getBoundingClientRect().top),
        avisoTemIcone: aviso ? aviso.querySelectorAll("svg").length : 0,
        avisoTexto: aviso?.textContent?.slice(0, 6) ?? "",
        filete: css?.borderLeftColor ?? "",
        fileteLargura: css?.borderLeftWidth ?? "",
        papel: getComputedStyle(document.body).backgroundColor,
      };
    });
    registrar(
      "a: nenhum dd cortado e o link de origem termina dentro da janela",
      proveniencia.cortados === 0 && proveniencia.linkDireita <= proveniencia.janela,
      `${proveniencia.cortados} cortados, link até ${proveniencia.linkDireita}/${proveniencia.janela} px`,
    );
    registrar(
      "b: aviso termina antes do bloco, com ícone e a palavra Aviso.",
      proveniencia.avisoFundo <= proveniencia.blocoTopo + 1 &&
        proveniencia.avisoTemIcone >= 1 &&
        proveniencia.avisoTexto.startsWith("Aviso."),
      `aviso até ${proveniencia.avisoFundo}, bloco em ${proveniencia.blocoTopo}, ${proveniencia.avisoTemIcone} ícone, "${proveniencia.avisoTexto}"`,
    );
    const cFilete = contrasteEmCinza(lerRgb(proveniencia.filete), lerRgb(proveniencia.papel));
    registrar(
      "b: filete do aviso (4 px) em cinza contra o papel >= 4,5:1",
      cFilete >= 4.5 && proveniencia.fileteLargura === "4px",
      `${cFilete.toFixed(2)}:1, largura ${proveniencia.fileteLargura}`,
    );
    registrar(
      "i: Fonte traduzida sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("fonte-traduzida");
    await cinza("fonte-traduzida");

    // ── (d) obra de uma seção ──
    await page.goto(`/acervo/${extras["fonte-uma-secao-teste"]}`);
    await expect(page.getByRole("heading", { level: 2, name: "Texto", exact: true })).toBeVisible();
    const uma = {
      paragrafo: await page.locator("#p-18\\.63").count(),
      sumario: await page.locator('[data-slot="sumario"], [data-slot="linha-secao"]').count(),
      secoes: await page.getByRole("heading", { name: /^Seções/ }).count(),
    };
    registrar(
      "d: texto na mesma página, sem sumário",
      uma.paragrafo === 1 && uma.sumario === 0 && uma.secoes === 0,
      `parágrafos ${uma.paragrafo}, sumário ${uma.sumario}, títulos Seções ${uma.secoes}`,
    );
    registrar(
      "i: obra de uma seção sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("fonte-uma-secao");

    // ── (e) rótulo do resumo auxiliar sem tocar em nada ──
    await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}/18`);
    await expect(page.locator('[data-slot="resumo-auxiliar"]')).toBeVisible();
    const rotulo = await page.locator('[data-slot="rotulo-resumo-auxiliar"]').evaluate((el) => {
      const css = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        texto: el.textContent ?? "",
        display: css.display,
        visibilidade: css.visibility,
        opacidade: css.opacity,
        altura: Math.round(r.height),
        direita: Math.round(r.right),
        janela: window.innerWidth,
        envolvido: !!el.closest("details, [aria-expanded], [hidden]"),
      };
    });
    registrar(
      "e: rótulo do resumo visível, inteiro, sem envoltório que recolhe",
      rotulo.texto ===
        "Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado." &&
        rotulo.display !== "none" &&
        rotulo.visibilidade === "visible" &&
        rotulo.opacidade === "1" &&
        rotulo.altura > 0 &&
        rotulo.direita <= rotulo.janela &&
        !rotulo.envolvido,
      `display ${rotulo.display}, altura ${rotulo.altura} px, até ${rotulo.direita}/${rotulo.janela} px, envolvido ${rotulo.envolvido}`,
    );
    registrar(
      "i: seção com resumo sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("secao-resumo");

    // ── Josefo real, seção 18: (f) parágrafo-alvo, (g) medida ──
    await page.goto("/acervo/josefo-antiguidades/18");
    const sem = await page.locator("#p-18\\.63").evaluate((el) => {
      const css = getComputedStyle(el);
      return { fundo: css.backgroundColor, sombra: css.boxShadow };
    });
    // Chegada como por um link de Citação: de outra página, com carga completa (não só troca de âncora).
    await page.goto("/acervo");
    await page.goto("/acervo/josefo-antiguidades/18#p-18.63");
    await expect(page.locator("#p-18\\.63")).toBeVisible();
    // A rolagem até a âncora acontece depois do carregamento (a página é longa e as fontes entram): espera.
    await expect
      .poll(
        () =>
          page.locator("#p-18\\.63").evaluate((el) => Math.round(el.getBoundingClientRect().top)),
        {
          timeout: 10_000,
        },
      )
      .toBeLessThan(page.viewportSize()?.height ?? 0);
    const alvo = await page.locator("#p-18\\.63").evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        fundo: css.backgroundColor,
        sombra: css.boxShadow,
        papel: getComputedStyle(document.body).backgroundColor,
        topo: Math.round(el.getBoundingClientRect().top),
      };
    });
    const filete = /rgba?\([^)]*\)/.exec(alvo.sombra)?.[0] ?? "rgb(0, 0, 0)";
    const cFundo = contrasteEmCinza(lerRgb(alvo.fundo), lerRgb(alvo.papel));
    const cFileteAlvo = contrasteEmCinza(lerRgb(filete), lerRgb(alvo.fundo));
    registrar(
      "f: alvo com filete de 2 px e preenchimento; o mesmo parágrafo sem âncora, nenhum dos dois",
      /inset/.test(alvo.sombra) &&
        /\b2px 0px 0px 0px\b/.test(alvo.sombra) &&
        alvo.fundo !== "rgba(0, 0, 0, 0)" &&
        sem.sombra === "none" &&
        sem.fundo === "rgba(0, 0, 0, 0)",
      `alvo: ${alvo.sombra} sobre ${alvo.fundo}; sem âncora: ${sem.sombra} / ${sem.fundo}`,
    );
    registrar(
      "f: em cinza, fundo do alvo diferente do papel (> 1,02:1) e filete contra o fundo >= 4,5:1",
      cFundo > 1.02 && cFileteAlvo >= 4.5,
      `fundo/papel ${cFundo.toFixed(3)}:1, filete/fundo ${cFileteAlvo.toFixed(2)}:1`,
    );
    registrar(
      "f: o parágrafo-alvo está na janela depois da âncora (rolagem até ele)",
      alvo.topo >= 0 && alvo.topo < (page.viewportSize()?.height ?? 0),
      `topo em ${alvo.topo} px`,
    );
    registrar(
      "i: seção real sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("secao-18-alvo", false);
    await cinza("secao-18-alvo");

    const medida = await page.evaluate(() => {
      const ps = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="paragrafo-fonte"]'),
      );
      const longo = ps.sort(
        (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0),
      )[0];
      if (!longo) return null;
      const texto = longo.lastChild as Text;
      const r = document.createRange();
      r.selectNodeContents(texto);
      const linhas = new Set(Array.from(r.getClientRects()).map((c) => Math.round(c.top))).size;
      return { caracteres: texto.length, linhas, media: texto.length / Math.max(linhas, 1) };
    });
    // Critério (g) vale em 1280 px, passo 1; nas demais combinações a medida é só informativa.
    const julga = largura >= 1280 && passo === 1;
    registrar(
      julga
        ? "g: média de caracteres por linha de parágrafo longo em inglês entre 58 e 62 (1280 px, passo 1)"
        : "g: média de caracteres por linha (informativo fora de 1280 px, passo 1)",
      julga ? !!medida && medida.media >= 58 && medida.media <= 62 : true,
      medida
        ? `${medida.caracteres} caracteres em ${medida.linhas} linhas = ${medida.media.toFixed(1)} por linha`
        : "sem parágrafo",
    );

    // ── (h) botões de seção nas seções 1, 2 e 20 do Josefo real ──
    const caixas: Record<
      string,
      {
        ant: DOMRect | null;
        prox: DOMRect | null;
        antDis: string | null;
        proxDis: string | null;
        motivos: string[];
      }
    > = {};
    for (const secao of ["1", "2", "20"]) {
      await page.goto(`/acervo/josefo-antiguidades/${secao}`);
      await expect(page.getByRole("navigation", { name: "Seções desta Fonte" })).toBeVisible();
      caixas[secao] = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Seções desta Fonte"]') as HTMLElement;
        const pegar = (t: string) =>
          Array.from(nav.querySelectorAll("a, button")).find(
            (e) => (e.textContent ?? "").trim() === t,
          ) as HTMLElement | undefined;
        const a = pegar("Seção anterior");
        const p = pegar("Próxima seção");
        const r = (e: HTMLElement | undefined) =>
          e ? (e.getBoundingClientRect().toJSON() as DOMRect) : null;
        return {
          ant: r(a),
          prox: r(p),
          antDis: a?.getAttribute("aria-disabled") ?? null,
          proxDis: p?.getAttribute("aria-disabled") ?? null,
          motivos: Array.from(nav.querySelectorAll("span.text-meta")).map(
            (e) => e.textContent ?? "",
          ),
        };
      });
      if (secao === "1") await foto("secao-1-extremo", false);
    }
    const c1 = caixas["1"];
    const c2 = caixas["2"];
    const c20 = caixas["20"];
    const mesmaPosicao = (k: "ant" | "prox") =>
      [c1, c2, c20].every(
        (c) =>
          c?.[k] &&
          Math.abs((c[k]?.x ?? 0) - (c1?.[k]?.x ?? 0)) < 1 &&
          Math.abs((c[k]?.width ?? 0) - (c1?.[k]?.width ?? 0)) < 1,
      );
    registrar(
      "h: 'Seção anterior' e 'Próxima seção' mantêm x e largura nas seções 1, 2 e 20",
      mesmaPosicao("ant") && mesmaPosicao("prox"),
      `anterior x=${c1?.ant?.x}/${c2?.ant?.x}/${c20?.ant?.x}; próxima x=${c1?.prox?.x}/${c2?.prox?.x}/${c20?.prox?.x}`,
    );
    registrar(
      "h: lado a lado na mesma linha, folga de 8 px, altura >= 44 px",
      [c1, c2, c20].every(
        (c) =>
          !!c?.ant &&
          !!c?.prox &&
          Math.abs(c.ant.top - c.prox.top) < 1 &&
          Math.abs(c.prox.left - (c.ant.left + c.ant.width) - 8) < 1 &&
          c.ant.height >= 44 &&
          c.prox.height >= 44,
      ),
      `folga ${((c1?.prox?.left ?? 0) - ((c1?.ant?.left ?? 0) + (c1?.ant?.width ?? 0))).toFixed(1)} px, alturas ${c1?.ant?.height}/${c1?.prox?.height}`,
    );
    registrar(
      "h: extremos aria-disabled com o motivo em texto",
      c1?.antDis === "true" &&
        c1.motivos.includes("Primeira seção") &&
        c20?.proxDis === "true" &&
        c20.motivos.includes("Última seção") &&
        c2?.antDis === null &&
        c2?.proxDis === null,
      `1: ${c1?.antDis}/${c1?.motivos.join()}; 20: ${c20?.proxDis}/${c20?.motivos.join()}`,
    );

    // ── (j) foco visível na ordem visual e o primeiro clique ──
    await page.goto("/acervo/josefo-antiguidades/2");
    await expect(page.getByRole("heading", { level: 1, name: "Livro 2" })).toBeVisible();
    const passos: { nome: string; topo: number; esq: number; contorno: number; pseudo: number }[] =
      [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      passos.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const r = el.getBoundingClientRect();
          const css = getComputedStyle(el);
          const ps = getComputedStyle(el, "::after");
          return {
            nome: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 28),
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
      "j: Tab segue a ordem visual (topo e esquerda não regridem)",
      ordem,
      passos.map((p) => `${p.nome}@${p.topo}`).join(" > "),
    );
    registrar(
      "j: todo foco com contorno >= 2 px",
      passos.every((p) => Math.max(p.contorno, p.pseudo) >= 2),
      passos.map((p) => Math.max(p.contorno, p.pseudo)).join(","),
    );
    await page.goto("/acervo/josefo-antiguidades/2");
    await expect(page.getByRole("heading", { level: 1, name: "Livro 2" })).toBeVisible();
    await page.getByRole("link", { name: "Próxima seção" }).click();
    await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades\/3$/);
    registrar(
      "j: primeiro clique em 'Próxima seção' navega",
      true,
      page.url().replace(/^.*\/acervo/, "/acervo"),
    );

    writeFileSync(
      path.join(PASTA as string, `06-fonte-secao-${nome}.json`),
      JSON.stringify({ projeto: info.project.name, largura, passo, resultado }, null, 2),
    );
    // O critério (g) é medido e declarado no arquivo de resultado, mas não derruba a execução: ele compara a medida
    // com a ESTIMATIVA do UI-SPEC (58 a 62), e a coluna de leitura é decisão da Fase 1 ("mantida igual").
    const falhas = resultado.filter((r) => !r.ok && !r.criterio.startsWith("g:"));
    expect(falhas, JSON.stringify(falhas, null, 2)).toEqual([]);
  });
}
