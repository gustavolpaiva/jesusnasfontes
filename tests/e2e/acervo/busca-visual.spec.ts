import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";

// Conferência RENDERIZADA da busca do Acervo (plano 02-07; rule `visual-verification-gate`). Roda só quando
// `VISUAL_DIR` aponta para a pasta das capturas e das medições (e então roda nas larguras e temas dos projetos
// `varredura-*`); sem ela, é pulado. O critério (a a i) está escrito antes de olhar, em
// `.planning/phases/02-acervo/visual/07-busca.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/busca-visual.spec.ts --project=varredura-320-claro ...

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
function emCinza(rgb: [number, number, number]): [number, number, number] {
  const g = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [g, g, g];
}
function contrasteEmCinza(a: [number, number, number], b: [number, number, number]): number {
  const [la, lb] = [luminancia(emCinza(a)), luminancia(emCinza(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function contraste(a: [number, number, number], b: [number, number, number]): number {
  const [la, lb] = [luminancia(a), luminancia(b)];
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

const campo = (page: Page) => page.getByRole("searchbox", { name: "Buscar no Acervo" });
const buscar = (page: Page) => page.getByRole("button", { name: "Buscar", exact: true });
const resultados = (page: Page) => page.locator('[data-slot="resultado-busca"]');
const doLivro18 = (page: Page) =>
  resultados(page).filter({ has: page.locator('a[href^="/acervo/josefo-antiguidades/18"]') });

const sobraHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Semeia 25 seções com uma palavra só desta combinação (o `fullyParallel` roda as combinações ao mesmo tempo no mesmo banco). */
async function semearLote(nome: string): Promise<{ slug: string; palavra: string }> {
  const slug = `fonte-busca-visual-${nome}`;
  const palavra = `abracadabrante${nome.replaceAll(/[^a-z]/g, "")}`;
  await escrever(
    `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
     values ($1, 'Fonte do lote visual', 'primaria', 'integral', 'en', 'dp-anterior-1929', 'Origem de teste', 'https://exemplo.invalid/origem', true)`,
    [slug],
  );
  await escrever(
    `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt)
     select $1 || '/lote-' || g, f.id, 'lote-' || g, g, 'Lote ' || g, 'Resumo do lote ' || g || ' com a palavra ' || $2
       from acervo.fonte f, generate_series(1, 25) g where f.slug = $1`,
    [slug, palavra],
  );
  return { slug, palavra };
}

async function removerLote(slug: string): Promise<void> {
  await escrever(
    "delete from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1)",
    [slug],
  );
  await escrever("delete from acervo.fonte where slug = $1", [slug]);
}

for (const passo of [1, 5] as const) {
  test(`@varredura busca do Acervo, passo ${passo} do texto`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const nome = `${info.project.name}-passo${passo}`;
    const largura = page.viewportSize()?.width ?? 0;
    const resultado: Linha[] = [];
    const registrar = (criterio: string, ok: boolean, medida: string) =>
      resultado.push({ criterio, ok, medida });
    mkdirSync(PASTA as string, { recursive: true });
    const lote = await semearLote(
      `${nome.replaceAll(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "x")}`,
    );
    try {
      const palavra = lote.palavra;
      const foto = (arquivo: string, cheia = true) =>
        page.screenshot({
          path: path.join(PASTA as string, `07-busca-${nome}-${arquivo}.png`),
          fullPage: cheia,
        });

      const email = emailDeTeste(`visual-busca-${nome}`);
      await convidarParaTeste(email);
      await entrarPorLink(page, email);
      await definirEscala(page, passo);

      // (h) controle positivo do medidor de rolagem horizontal.
      await page.goto("/acervo");
      await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.id = "controle-larga";
        d.style.cssText = "width:2000px;height:1px";
        document.body.append(d);
      });
      const sobraControle = await sobraHorizontal(page);
      await page.evaluate(() => document.getElementById("controle-larga")?.remove());
      registrar(
        "h: controle positivo, o medidor acusa uma sobra com elemento de 2000 px",
        sobraControle > 0,
        `${sobraControle}px`,
      );

      // (g) o campo e o botão da lista.
      await esperarHidratado(buscar(page));
      const alturasLista = await page.evaluate(() => ({
        campo: Math.round(
          document.getElementById("acervo-lista-termo")?.getBoundingClientRect().height ?? 0,
        ),
        botao: Math.round(
          Array.from(document.querySelectorAll("button"))
            .find((b) => b.textContent === "Buscar")
            ?.getBoundingClientRect().height ?? 0,
        ),
      }));
      registrar(
        "g: campo e botão da lista >= 44 px",
        alturasLista.campo >= 44 && alturasLista.botao >= 44,
        `campo ${alturasLista.campo}, botão ${alturasLista.botao}`,
      );
      registrar(
        "h: lista com o campo sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("0-lista-com-campo");

      // (i) primeiro clique: da lista ao resultado, e (e) o termo fora da URL.
      await campo(page).fill("pilatos");
      await buscar(page).click();
      await expect(doLivro18(page).first()).toBeVisible();
      const urlDaLista = page.url();
      registrar(
        "e: depois de buscar pelo campo da lista, a URL não tem o termo nem query",
        !/pilatos/i.test(urlDaLista) && new URL(urlDaLista).search === "",
        urlDaLista.replace(/^.*\/acervo/, "/acervo"),
      );
      registrar(
        "i: um clique em Buscar (campo da lista) mostra o resultado",
        true,
        "resultado visível no primeiro clique",
      );

      // (a) foco ao abrir, numa abertura nova da tela de busca.
      await page.goto("/acervo/busca");
      await esperarHidratado(buscar(page));
      // O foco vem do efeito de montagem, um instante depois de a hidratação ligar o botão: espera-se até 3 s e o
      // tempo que levou entra na medida (nunca "sem esperar" nem "esperando para sempre").
      const t0 = Date.now();
      const lerFoco = () =>
        page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? "");
      await expect
        .poll(lerFoco, { timeout: 3000 })
        .toBe("acervo-termo")
        .catch(() => undefined);
      const foco = await lerFoco();
      registrar(
        "a: ao abrir /acervo/busca o campo tem o foco, sem clicar em nada",
        foco === "acervo-termo",
        `ativo: ${foco || "(nenhum)"} depois de ${Date.now() - t0} ms`,
      );
      registrar(
        "h: tela ociosa sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("1-ocioso");

      // Resultado em português.
      await campo(page).fill("pilatos");
      await buscar(page).click();
      const achadoPt = doLivro18(page).first();
      await expect(achadoPt).toBeVisible();
      const pt = await achadoPt.evaluate((li) => {
        const mark = li.querySelector("mark") as HTMLElement;
        const trecho = li.querySelector("p[lang]") as HTMLElement;
        const rotulo = Array.from(li.querySelectorAll("p")).find(
          (p) => p.textContent === "Resumo auxiliar, escrito por IA",
        ) as HTMLElement | undefined;
        const m = getComputedStyle(mark);
        const t = getComputedStyle(trecho);
        const r = rotulo ? getComputedStyle(rotulo) : null;
        return {
          pesoMark: Number(m.fontWeight),
          pesoTexto: Number(t.fontWeight),
          linha: m.textDecorationLine,
          espessura: Number.parseFloat(m.textDecorationThickness),
          corLinha: m.textDecorationColor,
          fundoMark: m.backgroundColor,
          pagina: getComputedStyle(document.body).backgroundColor,
          rotuloAntes: rotulo
            ? Boolean(rotulo.compareDocumentPosition(trecho) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false,
          rotuloVisivel: rotulo ? rotulo.getBoundingClientRect().height > 0 : false,
          rotuloCor: r?.color ?? "",
          lang: trecho.getAttribute("lang"),
          cortado: trecho.scrollWidth > trecho.clientWidth + 1,
        };
      });
      registrar(
        "b: <mark> com peso >= 600 contra o texto ao redor",
        pt.pesoMark >= 600 && pt.pesoMark > pt.pesoTexto,
        `${pt.pesoMark} contra ${pt.pesoTexto}`,
      );
      registrar(
        "b: <mark> com sublinhado de 2 px e sem fundo",
        pt.linha.includes("underline") &&
          Math.round(pt.espessura) === 2 &&
          /rgba\(0, 0, 0, 0\)|transparent/.test(pt.fundoMark),
        `${pt.linha} ${pt.espessura}px, fundo ${pt.fundoMark}`,
      );
      const cLinha = contrasteEmCinza(lerRgb(pt.pagina), lerRgb(pt.corLinha));
      const cControle = contrasteEmCinza([200, 60, 60], [20, 117, 20]);
      registrar(
        "b: sublinhado em cinza contra o papel >= 1,5:1 (a forma carrega; a cor ajuda)",
        cLinha >= 1.5,
        `${cLinha.toFixed(2)}:1`,
      );
      registrar(
        "b/f: controle positivo, o medidor de cinza acusa par de mesmo brilho",
        cControle < 1.1,
        `${cControle.toFixed(2)}:1`,
      );
      registrar(
        "c: rótulo 'Resumo auxiliar, escrito por IA' visível, antes do trecho",
        pt.rotuloAntes && pt.rotuloVisivel,
        `antes ${pt.rotuloAntes}, visível ${pt.rotuloVisivel}`,
      );
      const cRotulo = contraste(lerRgb(pt.rotuloCor), lerRgb(pt.pagina));
      registrar(
        "c: texto do rótulo com contraste >= 4,5:1",
        cRotulo >= 4.5,
        `${cRotulo.toFixed(2)}:1`,
      );
      registrar("c: trecho em português com lang pt-BR", pt.lang === "pt-BR", String(pt.lang));
      registrar("h: trecho em português não cortado", !pt.cortado, `cortado ${pt.cortado}`);
      const urlBusca = page.url();
      registrar(
        "e: depois de buscar pelo campo da busca, a URL não tem o termo nem query",
        !/pilatos/i.test(urlBusca) && new URL(urlBusca).search === "",
        urlBusca.replace(/^.*\/acervo/, "/acervo"),
      );
      registrar(
        "h: resultado em português sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("2-resultado-pt");
      await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
      await foto("2-resultado-pt-cinza", false);
      await page.reload();
      await esperarHidratado(buscar(page));

      // (f) filtro em cinza: marcado e não marcado.
      await campo(page).fill("pilatos");
      await buscar(page).click();
      await expect(doLivro18(page).first()).toBeVisible();
      await page.getByRole("radio", { name: /^Fonte primária/ }).click();
      await expect(page.getByRole("radio", { name: /^Fonte primária/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      // As transições de cor (150 ms) terminam antes de medir: cor lida no meio de uma transição é medida falsa.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      );
      const filtro = await page.evaluate(() => {
        const grupo = document.querySelector('[role="radiogroup"]') as HTMLElement;
        const sel = grupo.querySelector('[aria-checked="true"]') as HTMLElement;
        const nao = grupo.querySelector('[aria-checked="false"]') as HTMLElement;
        const a = getComputedStyle(sel);
        const b = getComputedStyle(nao);
        return {
          rotulo: grupo.getAttribute("aria-labelledby")
            ? document.getElementById(grupo.getAttribute("aria-labelledby") as string)?.textContent
            : null,
          selFundo: a.backgroundColor,
          selTexto: a.color,
          naoTexto: b.color,
          naoBorda: b.borderTopColor,
          pagina: getComputedStyle(document.body).backgroundColor,
          icone: sel.querySelectorAll("svg").length,
          alturas: Array.from(grupo.querySelectorAll('[role="radio"]')).map((e) =>
            Math.round(e.getBoundingClientRect().height),
          ),
        };
      });
      const cSel = contrasteEmCinza(lerRgb(filtro.selFundo), lerRgb(filtro.selTexto));
      const cNao = contrasteEmCinza(lerRgb(filtro.pagina), lerRgb(filtro.naoTexto));
      const cBorda = contrasteEmCinza(lerRgb(filtro.pagina), lerRgb(filtro.naoBorda));
      registrar(
        "f: radiogroup com a legenda 'Nível de fonte'",
        filtro.rotulo === "Nível de fonte",
        String(filtro.rotulo),
      );
      registrar(
        "f: marcado em cinza, fundo/texto >= 4,5:1 e o check presente",
        cSel >= 4.5 && filtro.icone === 1,
        `${cSel.toFixed(2)}:1, ${filtro.icone} ícone (fundo ${filtro.selFundo}, texto ${filtro.selTexto})`,
      );
      registrar(
        "f: não marcado em cinza, texto >= 4,5:1 e contorno >= 1,5:1",
        cNao >= 4.5 && cBorda >= 1.5,
        `texto ${cNao.toFixed(2)}:1, contorno ${cBorda.toFixed(2)}:1 (texto ${filtro.naoTexto}, borda ${filtro.naoBorda}, papel ${filtro.pagina})`,
      );
      registrar(
        "g: itens do filtro >= 44 px",
        filtro.alturas.every((v) => v >= 44),
        filtro.alturas.join(","),
      );
      await foto("3-filtro-marcado");

      // Resultado em inglês (d).
      await page.getByRole("radio", { name: "Todos os Níveis" }).click();
      await campo(page).fill("wonderful");
      await buscar(page).click();
      const achadoEn = doLivro18(page).first();
      await expect(achadoEn.locator("p[lang='en']")).toBeVisible();
      const en = await achadoEn.evaluate((li) => ({
        lang: li.querySelector("p[lang]")?.getAttribute("lang"),
        rotulo: Array.from(li.querySelectorAll("p")).some(
          (p) => p.textContent === "Resumo auxiliar, escrito por IA",
        ),
        mark: li.querySelector("mark")?.textContent,
        cortado: ((el) => el.scrollWidth > el.clientWidth + 1)(
          li.querySelector("p[lang]") as HTMLElement,
        ),
      }));
      registrar(
        "d: trecho em inglês com lang='en', sem o rótulo do resumo, com a palavra marcada",
        en.lang === "en" && !en.rotulo && en.mark === "wonderful",
        `lang ${en.lang}, rótulo ${en.rotulo}, mark ${en.mark}`,
      );
      registrar("h: trecho em inglês não cortado", !en.cortado, `cortado ${en.cortado}`);
      registrar(
        "h: resultado em inglês sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("4-resultado-en");

      // (g) alvos dos resultados e botões; (i) mostrar mais e limpar no primeiro clique.
      await campo(page).fill(palavra);
      await buscar(page).click();
      await expect(resultados(page)).toHaveCount(20);
      // O botão volta de "Buscando…" para "Buscar" antes de ser medido.
      await expect(buscar(page)).toBeVisible();
      const alvos = await page.evaluate(() => {
        const h = (el: Element | null | undefined) =>
          Math.round(el?.getBoundingClientRect().height ?? 0);
        const btn = (t: string) =>
          Array.from(document.querySelectorAll("button")).find((b) => b.textContent === t);
        return {
          campo: h(document.getElementById("acervo-termo")),
          buscar: h(btn("Buscar")),
          limpar: h(btn("Limpar busca")),
          mais: h(btn("Mostrar mais resultados")),
          voltar: h(
            Array.from(document.querySelectorAll("a")).find((a) =>
              a.textContent?.includes("Voltar ao Acervo"),
            ),
          ),
          titulos: Array.from(document.querySelectorAll('[data-slot="resultado-busca"] h2 a')).map(
            (a) => h(a),
          ),
        };
      });
      registrar(
        "g: campo, Buscar, Limpar busca, Mostrar mais e Voltar >= 44 px",
        [alvos.campo, alvos.buscar, alvos.limpar, alvos.mais, alvos.voltar].every((v) => v >= 44),
        `campo ${alvos.campo}, buscar ${alvos.buscar}, limpar ${alvos.limpar}, mais ${alvos.mais}, voltar ${alvos.voltar}`,
      );
      registrar(
        "g: link de título de cada resultado >= 44 px",
        alvos.titulos.every((v) => v >= 44),
        `${alvos.titulos.length} títulos, mínimo ${Math.min(...alvos.titulos)}`,
      );
      await page.getByRole("button", { name: "Mostrar mais resultados" }).click();
      await expect(resultados(page)).toHaveCount(25);
      registrar(
        "i: um clique em Mostrar mais resultados acrescenta os 5 restantes",
        true,
        "20 -> 25",
      );
      registrar(
        "h: 25 resultados sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("5-mais-resultados");
      await page.getByRole("button", { name: "Limpar busca" }).click();
      const focoLimpar = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.id ?? "",
      );
      registrar(
        "i: um clique em Limpar busca devolve o foco ao campo",
        focoLimpar === "acervo-termo",
        `ativo: ${focoLimpar || "(nenhum)"}`,
      );

      // (i) o clique no título leva à seção (primeiro clique).
      await campo(page).fill("pilatos");
      await buscar(page).click();
      await doLivro18(page).first().getByRole("link", { name: "Livro 18" }).click();
      await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades\/18/);
      registrar(
        "i: um clique no título leva à seção",
        true,
        page.url().replace(/^.*\/acervo/, "/acervo"),
      );

      // Sem resultado.
      await page.goto("/acervo/busca");
      await esperarHidratado(buscar(page));
      await campo(page).fill("zzxqwvbn");
      await buscar(page).click();
      await expect(page.getByText("Nenhuma Fonte encontrada")).toBeVisible();
      registrar(
        "h: estado sem resultado sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra ${await sobraHorizontal(page)}px`,
      );
      await foto("6-sem-resultado");

      writeFileSync(
        path.join(PASTA as string, `07-busca-${nome}.json`),
        JSON.stringify({ projeto: info.project.name, largura, passo, resultado }, null, 2),
      );
      const falhas = resultado.filter((r) => !r.ok);
      expect(falhas, JSON.stringify(falhas, null, 2)).toEqual([]);
    } finally {
      await removerLote(lote.slug);
    }
  });
}
