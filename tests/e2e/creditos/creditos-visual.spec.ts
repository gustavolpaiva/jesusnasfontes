import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect as esperar, type Page, test } from "@playwright/test";
import { parse } from "yaml";

// Conferência RENDERIZADA da página de créditos com a seção "Textos do Acervo" (plano 02-22; rule
// `visual-verification-gate`). Roda só com `VISUAL_DIR` (pasta das capturas e das medições) e com UM processo
// (`--workers=1`). O critério (a a f) está escrito ANTES de olhar, em
// `.planning/phases/02-acervo/visual/22-creditos.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/creditos/creditos-visual.spec.ts --workers=1
//
// Larguras 320, 390 e 1280 px, claro e escuro (os projetos `varredura-*`; a variante `390-claro` roda no projeto de
// 390 px escuro, que a roda com o tema claro emulado), passo 1 do texto; e o passo 5 em 320 px, no Chromium e no WebKit
// (o WebKit é o motor do projeto `celular`: foi nele que um endereço longo deixou de quebrar).

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): sob a carga de vários processos o padrão de 5 s dá falso vermelho.
const expect = esperar.configure({ timeout: 30000 });

type Linha = { criterio: string; ok: boolean; medida: string };
type Rgb = [number, number, number];

type Origem = { nome: string; arquivos: { slug: string }[] };
const origens = parse(readFileSync("data/acervo-origens.yaml", "utf8")) as Record<string, Origem>;
type Fonte = { slug: string; publicada: boolean; tipo_texto: string };
const publicadas = new Set(
  readdirSync(path.join("content", "acervo", "fontes"))
    .filter((nome) => nome.endsWith(".yaml"))
    .map(
      (nome) =>
        parse(readFileSync(path.join("content", "acervo", "fontes", nome), "utf8")) as Fonte,
    )
    .filter((f) => f.publicada && f.tipo_texto === "integral")
    .map((f) => f.slug),
);
// Origens de que o site usa ao menos uma Fonte publicada, na ordem do registro.
const usadas = Object.values(origens).filter((o) => o.arquivos.some((a) => publicadas.has(a.slug)));
const INICIO_DO_PERSEUS = "Perseus Digital Library, canonical-greekLit (Antiquities";
const LICENCA_DUAL =
  "Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.";

function luminancia(rgb: Rgb): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}
function emCinza(rgb: Rgb): Rgb {
  const g = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [g, g, g];
}
function razao(la: number, lb: number): number {
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const contraste = (a: Rgb, b: Rgb) => razao(luminancia(a), luminancia(b));
const contrasteEmCinza = (a: Rgb, b: Rgb) => razao(luminancia(emCinza(a)), luminancia(emCinza(b)));
function lerRgb(css: string): Rgb {
  const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(css);
  if (!m) throw new Error(`cor ilegível: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const sobraHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// Texto CORTADO (`overflow:hidden`) conta como falha; ficam de fora o que rola de propósito, o inline e o só-leitor-de-tela.
// Uma função só: a medição real e o controle passam por ela.
function medirCortados(raiz: string): number {
  return Array.from(document.querySelectorAll<HTMLElement>(`${raiz} *`)).filter((e) => {
    const css = getComputedStyle(e);
    return (
      e.scrollWidth > e.clientWidth + 1 &&
      css.display !== "inline" &&
      !e.classList.contains("sr-only") &&
      css.overflowX !== "auto" &&
      css.overflowX !== "scroll"
    );
  }).length;
}

/**
 * O que passa da borda direita da janela: a CAIXA de um elemento visível e o TEXTO que pinta além dela
 * (um bloco que cabe na coluna pode ter texto maior do que ele, e é isso que alarga a página). É este
 * medidor que enxerga o endereço que não quebra; o das caixas, sozinho, não via.
 */
function medirAlemDaBorda(raiz: string) {
  const largura = document.documentElement.clientWidth;
  const alvo = document.querySelector(raiz) as HTMLElement | null;
  if (!alvo) return { caixas: 0, textos: 0, amostra: [] as string[] };
  const nome = (el: Element, b: DOMRect) =>
    `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? `.${el.className.split(" ").slice(0, 4).join(".")}` : ""} right=${Math.round(b.right)}`;
  const visivel = (e: HTMLElement) => {
    if (e.closest(".sr-only")) return false;
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none";
  };
  const elementos = [alvo, ...alvo.querySelectorAll<HTMLElement>("*")].filter(visivel);
  const fora = elementos
    .filter((e) => e.getBoundingClientRect().right > largura + 1)
    .map((e) => nome(e, e.getBoundingClientRect()));
  const textos: string[] = [];
  const walker = document.createTreeWalker(alvo, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const pai = n.parentElement;
    if (!pai || pai.closest(".sr-only")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const b of range.getClientRects()) {
      if (b.width > 0 && b.right > largura + 1) {
        textos.push(`"${(n.textContent ?? "").trim().slice(0, 40)}" ${nome(pai, b)}`);
        break;
      }
    }
  }
  return { caixas: fora.length, textos: textos.length, amostra: [...fora, ...textos].slice(0, 6) };
}
const alemDaBorda = (page: Page) => page.evaluate(medirAlemDaBorda, "main");
const cortados = (page: Page) => page.evaluate(medirCortados, "main");

/** Links de endereço (licença e origem) cabem na coluna: caixa e texto dentro da janela. */
const enderecos = (page: Page) =>
  page.locator('[data-slot="creditos-do-acervo"] dd a').evaluateAll((as) =>
    as.map((a) => {
      const b = a.getBoundingClientRect();
      const largura = document.documentElement.clientWidth;
      return {
        dentro: b.left >= -1 && b.right <= largura + 1 && a.scrollWidth <= a.clientWidth + 1,
        texto: (a.textContent ?? "").trim().slice(0, 50),
      };
    }),
  );

/**
 * O endereço de origem vive dentro de parênteses na frase "Versão ou data (endereço)". Mede, em cada `dd` com um link
 * de endereço, se o "(" está na MESMA linha em que o link começa e o ")" na MESMA linha em que ele termina. O defeito
 * que isto pega: o link como bloco pula para a linha de baixo inteiro e deixa o "(" sozinho no fim da linha anterior e o
 * ")" sozinho na linha seguinte. Devolve quantos `dd` violam (e uma amostra).
 */
function medirParenteses(raiz: string) {
  const alvo = document.querySelector(raiz);
  const violacoes: string[] = [];
  let medidos = 0;
  if (!alvo) return { medidos, violacoes: violacoes.length, amostra: violacoes };
  const linhaDoCaractere = (no: Node, posicao: number): number | null => {
    const r = document.createRange();
    r.setStart(no, posicao);
    r.setEnd(no, posicao + 1);
    const caixa = r.getClientRects()[0];
    return caixa ? caixa.top + caixa.height / 2 : null;
  };
  for (const a of alvo.querySelectorAll<HTMLElement>("dd a.break-all")) {
    const antes = a.previousSibling;
    const depois = a.nextSibling;
    const abre = antes?.nodeType === Node.TEXT_NODE ? (antes.textContent ?? "") : "";
    const fecha = depois?.nodeType === Node.TEXT_NODE ? (depois.textContent ?? "") : "";
    const nome = (a.textContent ?? "").trim().slice(0, 40);
    medidos += 1;
    const abreLimpo = abre.trimEnd();
    const fechaLimpo = fecha.trimStart();
    if (!abreLimpo.endsWith("(") || !fechaLimpo.startsWith(")")) {
      violacoes.push(`${nome}: o link não está entre parênteses`);
      continue;
    }
    const pedacos = [...a.getClientRects()].filter((p) => p.width > 0 && p.height > 0);
    const primeiro = pedacos[0];
    const ultimo = pedacos.at(-1);
    const topoAbre = linhaDoCaractere(antes as Node, abre.lastIndexOf("("));
    const topoFecha = linhaDoCaractere(depois as Node, fecha.indexOf(")"));
    if (!primeiro || !ultimo || topoAbre === null || topoFecha === null) {
      violacoes.push(`${nome}: sem geometria para medir`);
      continue;
    }
    const meioDoPrimeiro = primeiro.top + primeiro.height / 2;
    const meioDoUltimo = ultimo.top + ultimo.height / 2;
    if (Math.abs(topoAbre - meioDoPrimeiro) > 6)
      violacoes.push(`${nome}: "(" numa linha e o link começa em outra`);
    if (Math.abs(topoFecha - meioDoUltimo) > 6)
      violacoes.push(`${nome}: ")" numa linha e o link termina em outra`);
  }
  return { medidos, violacoes: violacoes.length, amostra: violacoes.slice(0, 4) };
}
const parenteses = (page: Page) => page.evaluate(medirParenteses, "main");

// ───────────────────────── os medidores de (b), (d) e (f), com os controles positivos ─────────────────────────

async function controlesPositivos(page: Page): Promise<Linha[]> {
  const linhas: Linha[] = [];
  // (b) texto cortado: o MESMO medidor acusa o bloco inserido em main.
  const cortadosAntes = await cortados(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "controle-texto-cortado";
    d.textContent = "textosemnenhumpontodequebranemmesmocomalgumaboavontade";
    d.style.cssText = "width:40px;white-space:nowrap;overflow:hidden";
    document.querySelector("main")?.append(d);
  });
  const cortadosCom = await cortados(page);
  await page.evaluate(() => document.getElementById("controle-texto-cortado")?.remove());
  linhas.push({
    criterio: "b: controle positivo, o medidor de texto cortado acusa o bloco inserido em main",
    ok: cortadosCom === cortadosAntes + 1,
    medida: `${cortadosAntes} antes do controle, ${cortadosCom} com ele`,
  });
  // (b)/(d) além da borda: um bloco mais largo que a janela, com texto longo, TEM de dar sobra e ser acusado como caixa e
  // como texto (um bloco largo com texto curto só exercita o medidor de caixas; e uma largura fixa cabe na janela de 1280 px).
  const sobraAntes = await sobraHorizontal(page);
  const bordaAntes = await alemDaBorda(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "controle-largo";
    d.textContent = "bloco de controle largo ".repeat(40).trim();
    d.style.cssText = "width:calc(100vw + 280px);white-space:nowrap";
    document.querySelector("main")?.append(d);
  });
  const sobraCom = await sobraHorizontal(page);
  const bordaCom = await alemDaBorda(page);
  await page.evaluate(() => document.getElementById("controle-largo")?.remove());
  linhas.push({
    criterio:
      "b/d: controle positivo, um bloco mais largo que a janela dá sobra e é acusado pelo medidor como caixa E como texto",
    ok:
      sobraCom > sobraAntes &&
      bordaCom.caixas === bordaAntes.caixas + 1 &&
      bordaCom.textos === bordaAntes.textos + 1,
    medida: `sobra ${sobraAntes} → ${sobraCom} px; caixas ${bordaAntes.caixas} → ${bordaCom.caixas}; textos ${bordaAntes.textos} → ${bordaCom.textos}`,
  });
  // (b) parênteses do endereço: o link posto como bloco (o defeito antigo) TEM de ser acusado.
  const parentesesAntes = await parenteses(page);
  await page.addStyleTag({ content: "main dd a.break-all{display:inline-block !important}" });
  const parentesesCom = await parenteses(page);
  await page.evaluate(() => {
    for (const s of document.querySelectorAll("style"))
      if (s.textContent === "main dd a.break-all{display:inline-block !important}") s.remove();
  });
  linhas.push({
    criterio:
      "b: controle positivo, o link de endereço posto como bloco deixa o '(' ou o ')' sozinho e o medidor de parênteses acusa",
    ok: parentesesAntes.medidos > 0 && parentesesCom.violacoes > parentesesAntes.violacoes,
    medida: `${parentesesAntes.violacoes} violações antes do controle, ${parentesesCom.violacoes} com ele (${parentesesAntes.medidos} endereços medidos)`,
  });
  // (f) texto fora da janela: um bloco com display none TEM de ser acusado.
  const escondidosAntes = await textosEscondidos(page);
  await page.evaluate(() => {
    const d = document.createElement("p");
    d.id = "controle-escondido";
    d.textContent = "texto de controle escondido";
    d.style.cssText = "display:none";
    document.querySelector("main")?.append(d);
  });
  const escondidosCom = await textosEscondidos(page);
  await page.evaluate(() => document.getElementById("controle-escondido")?.remove());
  linhas.push({
    criterio:
      "f: controle positivo, o medidor de texto fora da janela acusa o bloco com display none",
    ok: escondidosCom === escondidosAntes + 1,
    medida: `${escondidosAntes} antes do controle, ${escondidosCom} com ele`,
  });
  return linhas;
}

const textosEscondidos = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return 0;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let no = walker.nextNode(); no; no = walker.nextNode()) {
      const pai = no.parentElement;
      if (!pai || pai.closest(".sr-only")) continue;
      if ((no.textContent ?? "").trim() && getComputedStyle(pai).display === "none") n += 1;
    }
    return n;
  });

// ───────────────────────── (f) percurso por Tab ─────────────────────────

type Parada = {
  tag: string;
  href: string | null;
  nome: string;
  topo: number;
  esquerda: number;
  fragmentos: number[][];
  fixo: boolean;
  noMain: boolean;
  estilo: string;
  largura: number;
};

async function percorrerComTab(page: Page): Promise<Parada[]> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const marca = document.createElement("span");
    marca.tabIndex = -1;
    document.body.prepend(marca);
    marca.focus();
    marca.remove();
  });
  const paradas: (Parada & { chave: string })[] = [];
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press("Tab");
    const p = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { fim: true as const };
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      let fixo = false;
      for (let pai: HTMLElement | null = el; pai; pai = pai.parentElement) {
        const pos = getComputedStyle(pai).position;
        if (pos === "fixed" || pos === "sticky") fixo = true;
      }
      return {
        fim: false as const,
        chave: `${el.tagName}#${[...document.querySelectorAll(el.tagName)].indexOf(el)}`,
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute("href"),
        nome: (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName)
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 40),
        topo: Math.round(r.top + window.scrollY),
        esquerda: Math.round(r.left + window.scrollX),
        // Os pedaços de linha do elemento (um link em prosa pode quebrar de linha): topo, esquerda, direita de cada um.
        fragmentos: [...el.getClientRects()]
          .filter((b) => b.width > 0 && b.height > 0)
          .map((b) => [
            Math.round(b.top + window.scrollY),
            Math.round(b.left + window.scrollX),
            Math.round(b.right + window.scrollX),
          ]),
        fixo,
        noMain: el.closest("main") !== null,
        estilo: c.outlineStyle,
        largura: Number.parseFloat(c.outlineWidth) || 0,
      };
    });
    if (p.fim) break;
    if (paradas.length > 2 && p.chave === paradas[0]?.chave) break;
    if (p.chave === paradas.at(-1)?.chave) break;
    paradas.push(p);
  }
  return paradas;
}

// ───────────────────────── a medição ─────────────────────────

type Medida = {
  passo: number;
  linhas: Linha[];
  alturaDaPagina: number;
};

async function medirPasso(page: Page, passo: number, tema: string): Promise<Medida> {
  const linhas: Linha[] = [];
  const registrar = (criterio: string, ok: boolean, medida: string) =>
    linhas.push({ criterio, ok, medida });
  const alturaDaPagina = await page.evaluate(() => document.documentElement.scrollHeight);

  // ── (b), (d): nada cortado, nada além da borda, sem rolagem; endereços na coluna ──
  const sobra = await sobraHorizontal(page);
  const corta = await cortados(page);
  const borda = await alemDaBorda(page);
  const linksDeEndereco = await enderecos(page);
  registrar(
    `b: passo ${passo}, ${tema}: nenhum texto cortado e nada além da borda direita (caixas e texto)`,
    corta === 0 && borda.caixas === 0 && borda.textos === 0,
    `${corta} cortados; ${borda.caixas} caixas e ${borda.textos} textos além da borda ${JSON.stringify(borda.amostra)}`,
  );
  registrar(`d: passo ${passo}, ${tema}: sem rolagem horizontal`, sobra <= 0, `sobra ${sobra} px`);
  registrar(
    `b: passo ${passo}, ${tema}: todo link de endereço da seção cabe na coluna`,
    linksDeEndereco.length > 0 && linksDeEndereco.every((l) => l.dentro),
    `${linksDeEndereco.length} links; fora: ${JSON.stringify(linksDeEndereco.filter((l) => !l.dentro))}`,
  );
  const paren = await parenteses(page);
  registrar(
    `b: passo ${passo}, ${tema}: em "Versão ou data" o "(" e o ")" ficam na mesma linha do endereço (o link flui em linha)`,
    paren.medidos > 0 && paren.violacoes === 0,
    `${paren.medidos} endereços; ${paren.violacoes} violações ${JSON.stringify(paren.amostra)}`,
  );
  return { passo, linhas, alturaDaPagina };
}

async function medirPagina(page: Page): Promise<{ linhas: Linha[]; observacoes: unknown }> {
  const linhas: Linha[] = [];
  const registrar = (criterio: string, ok: boolean, medida: string) =>
    linhas.push({ criterio, ok, medida });
  const secao = page.locator('[data-slot="creditos-do-acervo"]');

  // ── (a) entradas geradas e "Usado em" com links ──
  const a = await page.evaluate(() => {
    const secao = document.querySelector('[data-slot="creditos-do-acervo"]') as HTMLElement | null;
    if (!secao) return { existe: false } as const;
    const titulos = [...secao.querySelectorAll(":scope > ul > li > h3")].map((h) =>
      (h.textContent ?? "").trim(),
    );
    const geral = [...document.querySelectorAll("main h2")].map((h) =>
      (h.textContent ?? "").trim(),
    );
    const usadoEm = [...secao.querySelectorAll("dl > div")]
      .filter((d) => (d.querySelector("dt")?.textContent ?? "").trim() === "Usado em")
      .map((d) => [...d.querySelectorAll("a")].map((x) => x.getAttribute("href") ?? ""));
    return { existe: true, titulos, geral, usadoEm } as const;
  });
  const esperados = usadas.map((o) => o.nome);
  const todosOsLinks = a.existe ? a.usadoEm.flat() : [];
  registrar(
    "a: a seção 'Textos do Acervo' existe depois das cinco entradas da Fase 1",
    a.existe && a.geral.slice(0, 5).length === 5 && a.geral[5] === "Textos do Acervo",
    a.existe ? `h2: ${JSON.stringify(a.geral)}` : "seção ausente",
  );
  registrar(
    "a: uma entrada por origem com ao menos uma Fonte publicada, na ordem do registro",
    a.existe && JSON.stringify(a.titulos) === JSON.stringify(esperados),
    `${a.existe ? a.titulos.length : 0} entradas para ${esperados.length} origens usadas`,
  );
  registrar(
    "a: toda entrada tem ao menos um link em 'Usado em', e a união é exatamente as Fontes publicadas, cada uma uma vez",
    a.existe &&
      a.usadoEm.length === esperados.length &&
      a.usadoEm.every((l) => l.length > 0) &&
      JSON.stringify([...todosOsLinks].sort()) ===
        JSON.stringify([...publicadas].map((s) => `/acervo/${s}`).sort()),
    `${a.existe ? a.usadoEm.length : 0} entradas com 'Usado em', ${todosOsLinks.length} links para ${publicadas.size} Fontes publicadas`,
  );

  // ── (c) a licença dual do Perseus ──
  const perseus = page.locator('[data-slot="creditos-do-acervo"] > ul > li').filter({
    has: page.getByRole("heading", {
      level: 3,
      name: new RegExp(`^${INICIO_DO_PERSEUS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    }),
  });
  const c = await perseus
    .locator("dl > div")
    .filter({ has: page.locator("dt").getByText("Licença", { exact: true }) })
    .locator("dd a")
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        texto: (el.textContent ?? "").trim(),
        href: el.getAttribute("href"),
        inteiro: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
        cor: css.color,
        fundo: getComputedStyle(document.body).backgroundColor,
      };
    });
  const contrasteDaLicenca = contraste(lerRgb(c.cor), lerRgb(c.fundo));
  registrar(
    "c: a licença do Perseus é o texto do vocabulário, inteiro, com contraste ≥ 4,5:1 e link para a licença Creative Commons",
    c.texto === LICENCA_DUAL &&
      c.inteiro &&
      contrasteDaLicenca >= 4.5 &&
      c.href === "https://creativecommons.org/licenses/by-sa/4.0/",
    `"${c.texto.slice(0, 50)}…" inteiro=${c.inteiro}; contraste ${contrasteDaLicenca.toFixed(2)}:1; ${c.href}`,
  );

  // ── (e) escala de cinza: contraste por tipo de texto, e forma (peso e sublinhado) ──
  const tipos = await secao.evaluate((s) => {
    const papel = getComputedStyle(document.body).backgroundColor;
    const ler = (el: Element | null) => {
      if (!el) return null;
      const css = getComputedStyle(el);
      return {
        cor: css.color,
        peso: css.fontWeight,
        sublinhado: css.textDecorationLine,
        tamanho: css.fontSize,
      };
    };
    return {
      papel,
      titulo: ler(s.querySelector("h3")),
      rotulo: ler(s.querySelector("dt")),
      valor: ler(s.querySelector("dd")),
      linkDeProsa: ler(s.querySelector("dd a:not(.break-all)")),
      linkDeEndereco: ler(s.querySelector("a.break-all")),
    };
  });
  const entradaDe = (t: { cor: string } | null) =>
    t ? contrasteEmCinza(lerRgb(t.cor), lerRgb(tipos.papel)) : 0;
  const contrastes = {
    titulo: entradaDe(tipos.titulo),
    rotulo: entradaDe(tipos.rotulo),
    valor: entradaDe(tipos.valor),
    linkDeProsa: entradaDe(tipos.linkDeProsa),
    linkDeEndereco: entradaDe(tipos.linkDeEndereco),
  };
  const menor = Math.min(...Object.values(contrastes));
  registrar(
    "e: em cinza, todo tipo de texto tem contraste ≥ 4,5:1",
    Object.values(contrastes).every((v) => v >= 4.5),
    `menor ${menor.toFixed(2)}:1; ` +
      Object.entries(contrastes)
        .map(([k, v]) => `${k} ${v.toFixed(2)}:1`)
        .join("; "),
  );
  registrar(
    "e: rótulo, valor e links distinguíveis por forma (peso do rótulo 600 e do valor 400; link com sublinhado), não por cor",
    tipos.rotulo?.peso === "600" &&
      tipos.valor?.peso === "400" &&
      (tipos.linkDeProsa?.sublinhado ?? "").includes("underline") &&
      (tipos.linkDeEndereco?.sublinhado ?? "").includes("underline") &&
      tipos.linkDeProsa?.cor === tipos.valor?.cor,
    `rótulo ${tipos.rotulo?.peso}, valor ${tipos.valor?.peso}, link de prosa ${tipos.linkDeProsa?.sublinhado} na cor do valor: ${tipos.linkDeProsa?.cor === tipos.valor?.cor}`,
  );

  // ── (f) Ctrl+F e teclado: nada recolhido, nenhum texto fora da janela, todo link alcançado por Tab ──
  const recolhaveis = await page.evaluate(
    () =>
      document.querySelectorAll(
        'main [data-slot="accordion"], main details:not([open]), main [hidden], main [aria-expanded]',
      ).length,
  );
  const escondidos = await textosEscondidos(page);
  registrar(
    "f: nenhum elemento recolhível e nenhum texto fora da janela (tudo acha por busca sem tocar em nada)",
    recolhaveis === 0 && escondidos === 0,
    `${recolhaveis} recolhíveis; ${escondidos} textos fora da janela; ${await page.evaluate(() => document.documentElement.scrollHeight)} px de altura`,
  );
  const paradas = await percorrerComTab(page);
  const noMain = paradas.filter((p) => p.noMain && p.href !== null);
  const todosOsLinksDaMain = await page
    .locator("main a[href]")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const alcancados = [...noMain.map((p) => p.href ?? "")].sort();
  // Ordem visual entre duas paradas vizinhas: a seguinte começa na última linha da anterior ou abaixo dela; se é na
  // mesma linha, começa depois do fim da anterior. Um link em prosa que quebra de linha tem mais de um pedaço: para a
  // anterior vale o seu ÚLTIMO pedaço (onde ela termina) e, para a seguinte, o PRIMEIRO (onde ela começa). O retângulo
  // que junta os pedaços mentiria: o de um link que quebra começa na linha de baixo e pareceria "à esquerda".
  const porPosicao = (a: number[], b: number[]) =>
    (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);
  const depoisDe = (x: Parada, y: Parada): boolean => {
    const fim = [...x.fragmentos].sort(porPosicao).at(-1);
    const inicio = [...y.fragmentos].sort(porPosicao)[0];
    if (!fim || !inicio) return true;
    if ((inicio[0] ?? 0) < (fim[0] ?? 0) - 4) return false;
    return Math.abs((inicio[0] ?? 0) - (fim[0] ?? 0)) > 8 || (inicio[1] ?? 0) >= (fim[2] ?? 0) - 4;
  };
  const emOrdem = noMain.map((p, i) => {
    const anterior = noMain[i - 1];
    if (!anterior || p.fixo || anterior.fixo) return true;
    return depoisDe(anterior, p);
  });
  const primeiraFora = emOrdem.findIndex((ok) => !ok);
  const descrever = (p: Parada | undefined) =>
    p ? `${p.nome} [${p.href}] pedaços=${JSON.stringify(p.fragmentos)}` : "—";
  const parForaDeOrdem =
    primeiraFora < 0
      ? "nenhuma"
      : `${descrever(noMain[primeiraFora - 1])} → ${descrever(noMain[primeiraFora])}`;
  registrar(
    "f: todo link da página é alcançado por Tab, na ordem de cima para baixo",
    JSON.stringify(alcancados) === JSON.stringify([...todosOsLinksDaMain].sort()) &&
      primeiraFora < 0,
    `${alcancados.length} de ${todosOsLinksDaMain.length} links alcançados em ${paradas.length} paradas; primeira fora de ordem: ${parForaDeOrdem}`,
  );
  // O indicador do Next (`nextjs-portal`) só existe no servidor de desenvolvimento: não é parte do produto e fica fora.
  const doProduto = paradas.filter((p) => p.tag !== "nextjs-portal");
  const semContorno = doProduto.filter((p) => p.estilo === "none" || p.largura < 2);
  registrar(
    "f: toda parada mostra contorno de foco (outline-style ≠ none, largura ≥ 2 px)",
    doProduto.length > 0 && semContorno.length === 0,
    `menor contorno ${Math.min(...doProduto.map((p) => p.largura))} px; sem contorno: ${JSON.stringify(semContorno.map((p) => `${p.tag} ${p.nome}`))}`,
  );

  // Observações medidas (NÃO são critério): o que um olho notaria primeiro e um número de contraste não mostra.
  const observacoes = await secao.evaluate((s) => {
    const linhasDe = (el: Element) => {
      const css = getComputedStyle(el);
      return Math.round(
        el.getBoundingClientRect().height / (Number.parseFloat(css.lineHeight) || 1),
      );
    };
    const titulos = [...s.querySelectorAll(":scope > ul > li > h3")].map((h) => ({
      nome: (h.textContent ?? "").trim(),
      linhas: linhasDe(h),
    }));
    // O primeiro link dentro de um `dd` da seção é a licença da primeira entrada (a do Perseus).
    const licenca = s.querySelector("dd a") as HTMLElement | null;
    const usadoEm = [...s.querySelectorAll("dl > div")]
      .filter((d) => (d.querySelector("dt")?.textContent ?? "").trim() === "Usado em")
      .map((d) => ({
        texto: (d.querySelector("dd")?.textContent ?? "").trim(),
        linhas: linhasDe(d.querySelector("dd") as Element),
      }));
    return {
      ondeComecaASecao_px: Math.round(s.getBoundingClientRect().top + window.scrollY),
      tituloMaisLongo: titulos.reduce((a, b) => (b.linhas > a.linhas ? b : a)),
      linhasDeCadaTitulo: titulos.map((t) => t.linhas),
      licencaDual: licenca
        ? { texto: (licenca.textContent ?? "").trim(), linhas: linhasDe(licenca) }
        : null,
      usadoEmMaisLongo: usadoEm.reduce((a, b) => (b.linhas > a.linhas ? b : a)),
    };
  });
  return { linhas, observacoes };
}

async function capturar(page: Page, arquivo: string, cheia = false): Promise<void> {
  await page.screenshot({ path: path.join(PASTA as string, `22-${arquivo}.png`), fullPage: cheia });
}
async function capturarEmCinza(page: Page, arquivo: string): Promise<void> {
  const css = "html{filter:grayscale(1)}";
  await page.addStyleTag({ content: css });
  await capturar(page, `${arquivo}-cinza`);
  await page.evaluate((texto) => {
    for (const s of document.querySelectorAll("style")) if (s.textContent === texto) s.remove();
  }, css);
}
/** Põe um elemento no topo da janela e espera o fim da rolagem. */
async function rolarAte(page: Page, seletor: string, nth = 0): Promise<void> {
  await page
    .locator(seletor)
    .nth(nth)
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(150);
}

for (const variante of ["projeto", "390-claro"] as const) {
  test(`@varredura creditos${variante === "projeto" ? "" : " (390-claro)"}`, async ({
    page,
    baseURL,
  }, info) => {
    test.setTimeout(300_000);
    if (variante === "projeto")
      test.skip(
        info.project.name === "varredura-360-claro",
        "as larguras da conferência são 320, 390 e 1280 px",
      );
    if (variante === "390-claro") {
      test.skip(info.project.name !== "varredura-390-escuro", "variante só no projeto de 390 px");
      await page.emulateMedia({ colorScheme: "light" });
    }
    const nome = variante === "390-claro" ? "varredura-390-claro" : info.project.name;
    const tema = nome.endsWith("escuro") ? "escuro" : "claro";
    const largura = page.viewportSize()?.width ?? 0;
    mkdirSync(PASTA as string, { recursive: true });
    const todas: Linha[] = [];

    await page.goto("/creditos");
    await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();

    todas.push(...(await controlesPositivos(page)));
    // A página volta ao topo depois dos controles e do percurso por Tab.
    const medida1 = await medirPasso(page, 1, tema);
    todas.push(...medida1.linhas);
    // Antes do percurso por Tab (que rola a página): as capturas do passo 1.
    await rolarAte(page, "#textos-do-acervo");
    await capturar(page, `topo-acervo-${nome}`);
    await capturarEmCinza(page, `topo-acervo-${nome}`);
    // A licença dual do Perseus: a linha inteira à mostra.
    const licencaDoPerseus = page
      .locator('[data-slot="creditos-do-acervo"] > ul > li')
      .first()
      .locator("dl > div")
      .filter({ has: page.locator("dt").getByText("Licença", { exact: true }) });
    await licencaDoPerseus.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(150);
    await capturar(page, `perseus-licenca-${nome}`);
    // A linha "Versão ou data" com o endereço entre parênteses: o "(" e o ")" têm de ficar junto do endereço.
    await page
      .locator('[data-slot="creditos-do-acervo"] a.break-all')
      .nth(2)
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(150);
    await capturar(page, `versao-endereco-${nome}`);
    const pagina = await medirPagina(page);
    todas.push(...pagina.linhas);

    // O passo 5 do texto em TODAS as larguras (o critério (b) e (d) foi declarado para os passos 1 e 5); é em
    // 320 px que a UI-SPEC manda não haver atribuição cortada.
    {
      await page
        .context()
        .addCookies([{ name: "escala-texto", value: "5", url: baseURL as string }]);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
      const escala = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--escala-texto").trim(),
      );
      todas.push({
        criterio: `d: controle positivo, o passo 5 está de fato aplicado em ${largura} px`,
        ok: Number(escala) > 1,
        medida: `--escala-texto ${escala}`,
      });
      const medida5 = await medirPasso(page, 5, tema);
      todas.push(...medida5.linhas);
      // O endereço que não quebrava no WebKit: a linha "Versão ou data" da primeira entrada do Acervo.
      await rolarAte(page, '[data-slot="creditos-do-acervo"] a.break-all');
      await capturar(page, `passo5-endereco-${nome}`);
    }

    writeFileSync(
      path.join(PASTA as string, `22-creditos-${nome}.json`),
      JSON.stringify(
        {
          largura,
          tema,
          alturaDaPagina: medida1.alturaDaPagina,
          linhas: todas,
          observacoes: pagina.observacoes,
        },
        null,
        2,
      ),
    );
    const reprovadas = todas.filter((l) => !l.ok);
    expect(reprovadas, JSON.stringify(reprovadas, null, 2)).toEqual([]);
  });
}

test("creditos no WebKit: 320 px, passo 5, sem texto além da borda e sem rolagem", async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "celular", "só no projeto de WebKit");
  test.setTimeout(300_000);
  mkdirSync(PASTA as string, { recursive: true });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/creditos");
  await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
  const linhas: Linha[] = [];
  linhas.push(...(await controlesPositivos(page)));
  linhas.push(...(await medirPasso(page, 1, "claro")).linhas);
  await page.context().addCookies([{ name: "escala-texto", value: "5", url: baseURL as string }]);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
  linhas.push(...(await medirPasso(page, 5, "claro")).linhas);
  await rolarAte(page, '[data-slot="creditos-do-acervo"] a.break-all');
  await capturar(page, "passo5-endereco-webkit-celular");
  writeFileSync(
    path.join(PASTA as string, "22-creditos-webkit-celular.json"),
    JSON.stringify({ motor: await page.evaluate(() => navigator.userAgent), linhas }, null, 2),
  );
  const reprovadas = linhas.filter((l) => !l.ok);
  expect(reprovadas, JSON.stringify(reprovadas, null, 2)).toEqual([]);
});
