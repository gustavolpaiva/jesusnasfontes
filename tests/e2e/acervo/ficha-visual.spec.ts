import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type FichasSemeadas, removerFichas, semearFichas } from "../../support/ficha-e2e";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Conferência RENDERIZADA da ficha e da carta de neutralidade (plano 02-16; rule `visual-verification-gate`). Roda só
// com `VISUAL_DIR` (pasta das capturas e das medições) e com `CARTA_DIR_PARA_TESTE` apontando para a fixture da carta
// (o texto real é do dono e não existe no produto). O critério (a a j) está escrito ANTES de olhar, em
// `.planning/phases/02-acervo/visual/16-ficha-carta.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> CARTA_DIR_PARA_TESTE=tests/fixtures/acervo/carta/valida \
//     pnpm test:e2e tests/e2e/acervo/ficha-visual.spec.ts --project=varredura-320-claro ...

const PASTA = process.env.VISUAL_DIR;
test.skip(
  !PASTA || !process.env.CARTA_DIR_PARA_TESTE,
  "conferência visual só com VISUAL_DIR e a carta de fixture",
);
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
let semeadas: FichasSemeadas;
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = `vis16-${info.project.name}`;
  semeadas = await semearFichas(sufixo);
});
test.afterAll(async () => {
  if (sufixo) await removerFichas(sufixo);
});

// O conjunto de projetos de varredura só tem 390 px no escuro: a variante `390-claro` roda neste mesmo projeto com o tema
// claro emulado, para o critério valer em 320, 390 e 1280 nos dois temas.
for (const [passo, variante] of [
  [1, "projeto"],
  [5, "projeto"],
  [1, "390-claro"],
  [5, "390-claro"],
] as const) {
  test(`@varredura ficha e carta, passo ${passo} do texto${variante === "projeto" ? "" : ` (${variante})`}`, async ({
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
        path: path.join(PASTA as string, `16-${arquivo}-${nome}.png`),
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

    const email = emailDeTeste(`visual-fc-${nome}`);
    await convidarParaTeste(email);
    await entrarPorLink(page, email);
    await definirEscala(page, passo);

    // ── Controles positivos dos medidores ──
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
      d.remove();
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = "x";
      a.style.cssText = "display:block;height:20px;outline:none";
      document.body.append(a);
      a.focus();
      const alvo = a.getBoundingClientRect().height;
      const css = getComputedStyle(a);
      const contorno = css.outlineStyle === "none" ? 0 : Number.parseFloat(css.outlineWidth);
      a.remove();
      return { estoura, alvo, contorno };
    });
    registrar(
      "g: controle positivo, o medidor de texto cortado acusa bloco que estoura",
      controle.estoura,
      `scrollWidth > clientWidth: ${controle.estoura}`,
    );
    registrar(
      "h: controle positivo, o medidor de alvo acusa link de 20 px",
      controle.alvo < 44,
      `${controle.alvo} px`,
    );
    registrar(
      "j: controle positivo, o medidor de foco acusa link sem contorno",
      controle.contorno < 2,
      `${controle.contorno} px`,
    );
    const par = contrasteEmCinza([200, 60, 60], [20, 117, 20]);
    registrar(
      "i: controle positivo, o cálculo de cinza acusa par de mesmo brilho",
      par < 1.1,
      `${par.toFixed(2)}:1`,
    );

    // ── Ficha completa ──
    await page.goto(`/acervo/${semeadas.slugs.completa}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Obra de Teste Completa" }),
    ).toBeVisible();

    // (a) página em cada item, abaixo do texto do próprio item
    const itens = await page.locator('[data-slot="item-de-ficha"]').evaluateAll((els) =>
      els.map((el) => {
        const paginas = el.querySelectorAll('[data-slot="pagina-do-item"]');
        const pagina = paginas[0] as HTMLElement | undefined;
        const blocos = Array.from(el.children).filter((c) => c !== pagina) as HTMLElement[];
        const fundoDoTexto = Math.max(...blocos.map((b) => b.getBoundingClientRect().bottom));
        const visivel = pagina?.querySelector('[aria-hidden="true"]')?.textContent ?? "";
        const falada = pagina?.querySelector(".sr-only")?.textContent ?? "";
        return {
          n: paginas.length,
          altura: pagina ? Math.round(pagina.getBoundingClientRect().height) : 0,
          abaixo: pagina ? pagina.getBoundingClientRect().top >= fundoDoTexto - 1 : false,
          visivel,
          falada,
        };
      }),
    );
    registrar(
      "a: 4 itens, cada um com uma página visível abaixo do próprio texto, começando por 'p. '",
      itens.length === 4 &&
        itens.every((i) => i.n === 1 && i.altura > 0 && i.abaixo && i.visivel.startsWith("p. ")),
      itens.map((i) => `${i.visivel}|${i.falada}`).join("; "),
    );
    registrar(
      "a: travessão U+2013 na faixa e 'página 39 a 53' para o leitor de tela",
      itens[0]?.visivel === "p. 39–53" && itens[0]?.falada === "página 39 a 53",
      `${itens[0]?.visivel} / ${itens[0]?.falada}`,
    );

    // (b) verificada sem nome
    const verif = await page.evaluate((emailDoAdmin) => {
      const el = document.querySelector('[data-slot="verificacao"]') as HTMLElement;
      const svg = el.querySelector("svg");
      const r = svg?.getBoundingClientRect();
      const tudo = document.documentElement.outerHTML;
      return {
        texto: el.querySelector("p")?.textContent ?? "",
        icone: r ? Math.round(r.width) : 0,
        alturaIcone: r ? Math.round(r.height) : 0,
        temEmail: tudo.includes(emailDoAdmin),
        temLocal: tudo.includes(emailDoAdmin.split("@")[0] as string),
      };
    }, semeadas.emailDoAdmin);
    registrar(
      "b: 'Verificada em {data}' com ícone de 16 px e sem o e-mail nem a parte local do Admin",
      /^Verificada em \d{1,2} de \p{L}+ de \d{4}$/u.test(verif.texto.trim()) &&
        verif.icone === 16 &&
        verif.alturaIcone === 16 &&
        !verif.temEmail &&
        !verif.temLocal,
      `"${verif.texto.trim()}", ícone ${verif.icone}x${verif.alturaIcone}, e-mail ${verif.temEmail}, local ${verif.temLocal}`,
    );

    // (c) completa: quatro h2 na ordem fixa
    const h2c = await page.locator("h2").allTextContents();
    registrar(
      "c: ficha completa com as quatro seções na ordem fixa",
      JSON.stringify(h2c) ===
        JSON.stringify(["Tese", "Argumentos", "Trechos citados", "O que esta obra não pode dizer"]),
      h2c.join(" > "),
    );

    // (d) trecho em q lang
    const qs = await page.locator("q").evaluateAll((els) =>
      els.map((el) => {
        const css = getComputedStyle(el);
        const papel = getComputedStyle(document.body).backgroundColor;
        return {
          lang: el.getAttribute("lang"),
          tamanho: (el.textContent ?? "").length,
          largura: css.borderLeftWidth,
          estilo: css.borderLeftStyle,
          cor: css.borderLeftColor,
          recuo: css.paddingLeft,
          direita: Math.round(el.getBoundingClientRect().right),
          janela: window.innerWidth,
          papel,
        };
      }),
    );
    registrar(
      "d: 2 trechos em <q lang='en'>, até 300 caracteres, filete sólido de 2 px, recuo de 16 px, dentro da janela",
      qs.length === 2 &&
        qs.every(
          (q) =>
            q.lang === "en" &&
            q.tamanho <= 300 &&
            q.largura === "2px" &&
            q.estilo === "solid" &&
            q.cor !== q.papel &&
            q.recuo === "16px" &&
            q.direita <= q.janela,
        ),
      qs
        .map(
          (q) =>
            `${q.tamanho} car., ${q.largura} ${q.estilo}, recuo ${q.recuo}, até ${q.direita}/${q.janela}`,
        )
        .join("; "),
    );

    // (e) sem capitular
    const cap = await page.evaluate(() => {
      const p = document.querySelector('[aria-labelledby="ficha-tese"] p') as HTMLElement;
      const base = getComputedStyle(p);
      const letra = getComputedStyle(p, "::first-letter");
      return {
        base: base.fontSize,
        letra: letra.fontSize,
        familiaBase: base.fontFamily,
        familiaLetra: letra.fontFamily,
        flutua: letra.float,
      };
    });
    registrar(
      "e: a Tese não tem capitular (letra inicial com o mesmo tamanho e a mesma família, sem float)",
      cap.base === cap.letra && cap.familiaBase === cap.familiaLetra && cap.flutua === "none",
      `${cap.letra} contra ${cap.base}; float ${cap.flutua}`,
    );

    // (g) rolagem e texto cortado
    const cortados = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="ficha"] *')).filter(
          (e) =>
            e.scrollWidth > e.clientWidth + 1 &&
            getComputedStyle(e).display !== "inline" &&
            !e.classList.contains("sr-only"),
        ).length,
    );
    registrar(
      "g: ficha completa sem rolagem horizontal e sem bloco cortado",
      (await sobraHorizontal(page)) <= 0 && cortados === 0,
      `sobra ${await sobraHorizontal(page)}px, ${cortados} blocos cortados`,
    );

    // (h) alvos
    const voltar = await page
      .getByRole("link", { name: "Voltar ao Acervo" })
      .evaluate((e) => Math.round(e.getBoundingClientRect().height));
    const linkCarta = await page
      .getByRole("link", { name: /Por que estas obras/ })
      .evaluate((e) => Math.round(e.getBoundingClientRect().height));
    registrar(
      "h: 'Voltar ao Acervo' e o link da carta na ficha >= 44 px",
      voltar >= 44 && linkCarta >= 44,
      `voltar ${voltar}, carta ${linkCarta}`,
    );

    // (i) cinza
    const cores = await page.evaluate(() => {
      const papel = getComputedStyle(document.body).backgroundColor;
      const cor = (sel: string) => getComputedStyle(document.querySelector(sel) as Element).color;
      return {
        papel,
        filete: getComputedStyle(document.querySelector("q") as Element).borderLeftColor,
        eyebrow: cor('[data-slot="ficha"] header p'),
        pagina: cor('[data-slot="pagina-do-item"]'),
        frase: cor('[data-slot="verificacao"] p:last-child'),
      };
    });
    const cin = (c: string) => contrasteEmCinza(lerRgb(c), lerRgb(cores.papel));
    registrar(
      "i: em cinza, filete, eyebrow, página do item e frase de verificação >= 4,5:1 contra o papel",
      [cores.filete, cores.eyebrow, cores.pagina, cores.frase].every((c) => cin(c) >= 4.5),
      `filete ${cin(cores.filete).toFixed(2)}, eyebrow ${cin(cores.eyebrow).toFixed(2)}, página ${cin(cores.pagina).toFixed(2)}, frase ${cin(cores.frase).toFixed(2)}`,
    );
    await foto("ficha-completa");
    await cinza("ficha-completa");

    // (j) foco na ordem visual com contorno
    const passos: { nome: string; topo: number; contorno: number }[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const p = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const r = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        return {
          nome: (el.textContent ?? "").trim().slice(0, 24),
          dentro: !!el.closest('[data-slot="ficha"]'),
          topo: Math.round(r.top + window.scrollY),
          contorno: css.outlineStyle === "none" ? 0 : Number.parseFloat(css.outlineWidth),
        };
      });
      if (p.dentro) passos.push(p);
    }
    registrar(
      "j: Tab percorre os links da ficha na ordem visual, todos com contorno >= 2 px",
      passos.length === 2 &&
        passos.every((p, i) => i === 0 || p.topo >= (passos[i - 1]?.topo ?? 0)) &&
        passos.every((p) => p.contorno >= 2),
      passos.map((p) => `${p.nome}@${p.topo}/${p.contorno}px`).join(" > "),
    );

    // ── Ficha enxuta: (c) sem título solto ──
    await page.goto(`/acervo/${semeadas.slugs.enxuta}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Obra de Teste Enxuta" }),
    ).toBeVisible();
    const enxuta = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="ficha"] h2'));
      return {
        titulos: hs.map((h) => h.textContent),
        vazios: hs.filter((h) => {
          const resto = Array.from(h.parentElement?.children ?? []).filter((c) => c !== h);
          return resto.every((c) => (c.textContent ?? "").trim() === "");
        }).length,
        rodape: Array.from(document.querySelectorAll('[data-slot="rodape-da-ficha"]')).filter(
          (r) => (r.textContent ?? "").trim() === "",
        ).length,
      };
    });
    registrar(
      "c: ficha enxuta com 2 títulos (Tese, Argumentos), nenhum sem conteúdo depois dele e sem rodapé vazio (com a carta publicada o rodapé existe e traz o link)",
      JSON.stringify(enxuta.titulos) === JSON.stringify(["Tese", "Argumentos"]) &&
        enxuta.vazios === 0 &&
        enxuta.rodape === 0,
      `${enxuta.titulos.join(" > ")}; vazios ${enxuta.vazios}; rodapés ${enxuta.rodape}`,
    );
    registrar(
      "g: ficha enxuta sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("ficha-enxuta");

    // ── Lista: link da carta ──
    await page.goto("/acervo");
    await expect(page.locator('[data-slot="link-da-carta"] a')).toBeVisible();
    const alvoLista = await page
      .locator('[data-slot="link-da-carta"] a')
      .evaluate((e) => Math.round(e.getBoundingClientRect().height));
    registrar(
      "h: link da carta na lista >= 44 px; g: lista sem rolagem horizontal",
      alvoLista >= 44 && (await sobraHorizontal(page)) <= 0,
      `link ${alvoLista}, sobra ${await sobraHorizontal(page)}px`,
    );
    await foto("lista-com-link", false);

    // ── Carta (fixture) ──
    await page.goto("/acervo/carta-de-neutralidade");
    await expect(
      page.getByRole("heading", { level: 1, name: "Carta de neutralidade" }),
    ).toBeVisible();
    const carta = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="carta"] h2'));
      const css = hs[0] ? getComputedStyle(hs[0]) : null;
      return {
        titulos: hs.map((h) => h.textContent),
        fonte: css?.fontSize ?? "",
        peso: css?.fontWeight ?? "",
        versao: document.querySelector('[data-slot="versao-da-carta"]')?.textContent ?? "",
        intruso: document.querySelectorAll("#intruso").length,
        literal: (document.querySelector('[data-slot="carta"]')?.textContent ?? "").includes(
          '<b id="intruso">marcação</b>',
        ),
      };
    });
    registrar(
      "f: carta com h1, dois h2 em Rótulo (15 px, peso 600), versão e data no rodapé, marcação literal",
      JSON.stringify(carta.titulos) ===
        JSON.stringify(["Critério de entrada", "O que ficou de fora"]) &&
        carta.fonte === "15px" &&
        carta.peso === "600" &&
        carta.versao === "Carta versão 1, de 24 de novembro de 2026." &&
        carta.intruso === 0 &&
        carta.literal,
      `${carta.titulos.join(" > ")}; ${carta.fonte}/${carta.peso}; "${carta.versao}"; #intruso ${carta.intruso}; literal ${carta.literal}`,
    );
    const voltarCarta = await page
      .getByRole("link", { name: "Voltar ao Acervo" })
      .evaluate((e) => Math.round(e.getBoundingClientRect().height));
    registrar(
      "g: carta sem rolagem horizontal; h: 'Voltar ao Acervo' da carta >= 44 px",
      (await sobraHorizontal(page)) <= 0 && voltarCarta >= 44,
      `sobra ${await sobraHorizontal(page)}px, voltar ${voltarCarta}`,
    );
    await foto("carta");
    await cinza("carta");

    // (j) primeiros cliques: ficha -> carta (pelo link), carta -> lista (Voltar)
    await page.goto(`/acervo/${semeadas.slugs.completa}`);
    await page.getByRole("link", { name: /Por que estas obras/ }).click();
    await expect(page).toHaveURL(/\/acervo\/carta-de-neutralidade$/);
    await page.getByRole("link", { name: "Voltar ao Acervo" }).click();
    await expect(page).toHaveURL(/\/acervo$/);
    registrar(
      "j: um clique no link da carta (ficha) leva à carta; um clique em 'Voltar ao Acervo' leva à lista",
      true,
      "ficha > carta > /acervo, cada um no primeiro clique",
    );
    await page.goto(`/acervo/${semeadas.slugs.completa}`);
    await page.getByRole("link", { name: "Voltar ao Acervo" }).click();
    await expect(page).toHaveURL(/\/acervo$/);

    writeFileSync(
      path.join(PASTA as string, `16-ficha-carta-${nome}.json`),
      JSON.stringify({ projeto: info.project.name, largura, passo, resultado }, null, 2),
    );
    const falhas = resultado.filter((r) => !r.ok);
    expect(falhas, JSON.stringify(falhas, null, 2)).toEqual([]);
  });
}
