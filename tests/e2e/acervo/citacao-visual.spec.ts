import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  ESTUDO_DA_CAPITULAR,
  ESTUDO_DA_VARREDURA,
  semearCitacaoDaCapitular,
  semearCitacoesDaVarredura,
} from "../../support/citacao-e2e";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
import { estadoDaFala, instalarFalaFalsa, VOZ_PT_BR } from "../../support/fala-falsa";
import { semearFichas } from "../../support/ficha-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Conferência RENDERIZADA da Citação no Estudo (plano 02-19; rule `visual-verification-gate`). Roda só com `VISUAL_DIR`
// (pasta das capturas e das medições). O critério (a a l) está escrito ANTES de olhar em
// `.planning/phases/02-acervo/visual/19-citacao.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/citacao-visual.spec.ts

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });
expect.configure({ timeout: 15_000 });

const LARGURAS_DA_CONFERENCIA = new Set([
  "varredura-320-claro",
  "varredura-320-escuro",
  "varredura-390-escuro",
  "varredura-1280-claro",
  "varredura-1280-escuro",
]);

type Linha = { criterio: string; ok: boolean; medida: string };

// Ruído preexistente, FORA do escopo da Citação (deferred-items): o Caderno põe `caret-color: transparent` no `textarea`
// antes de hidratar e o React avisa. Só esse aviso é descartado, pelo texto da árvore que ele mesmo imprime.
const RUIDO_DO_CADERNO = /anotacao-campo/;
const NAO_PODE_APARECER =
  /hydrat|validateDOMNesting|cannot be a descendant|cannot contain|did not match/i;

// A semeadura é UMA por processo: o banco da execução é descartável e as fichas ficam (a Citação aponta para elas).
let semeado: Promise<void> | undefined;
function semear(projeto: string): Promise<void> {
  semeado ??= (async () => {
    const fichas = await semearFichas(`vis19-${projeto}-${process.pid}`);
    await semearCitacoesDaVarredura(fichas.slugs.completa);
    await semearCitacaoDaCapitular();
  })();
  return semeado;
}

const sobraHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Texto cortado dentro de `main`: conteúdo mais largo que a caixa, fora o que rola de propósito, o inline e o `sr-only`. */
function medirCortados(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("main *"))
    .filter((e) => {
      const css = getComputedStyle(e);
      return (
        e.scrollWidth > e.clientWidth + 1 &&
        css.display !== "inline" &&
        !e.classList.contains("sr-only") &&
        css.overflowX !== "auto" &&
        css.overflowX !== "scroll"
      );
    })
    .map(
      (e) =>
        `${e.tagName.toLowerCase()}[${e.dataset.slot ?? ""}] ${e.scrollWidth}>${e.clientWidth} ox=${getComputedStyle(e).overflowX}`,
    );
}

type Rgb = [number, number, number];
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
function contrasteEmCinza(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminancia(emCinza(a)), luminancia(emCinza(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function lerRgb(css: string): Rgb {
  const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(css);
  if (!m) throw new Error(`cor ilegível: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function vigiarConsole(page: Page): string[] {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (NAO_PODE_APARECER.test(m.text()) && !RUIDO_DO_CADERNO.test(m.text())) avisos.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (NAO_PODE_APARECER.test(e.message) && !RUIDO_DO_CADERNO.test(e.message))
      avisos.push(e.message);
  });
  return avisos;
}

for (const passo of ["1", "5"] as const) {
  for (const reduzido of [false, true]) {
    test(`@varredura citação renderizada, passo ${passo}${reduzido ? ", movimento reduzido" : ""}`, async ({
      page,
      context,
      baseURL,
    }, info) => {
      test.setTimeout(300_000);
      const nome = info.project.name;
      test.skip(!LARGURAS_DA_CONFERENCIA.has(nome), "largura fora da conferência");
      // A passada de movimento reduzido só no projeto de 390 px (critério j); as demais são completas.
      test.skip(reduzido && nome !== "varredura-390-escuro", "movimento reduzido só em 390-escuro");
      const largura = page.viewportSize()?.width ?? 0;
      const resultado: Linha[] = [];
      const registrar = (criterio: string, ok: boolean, medida: string) =>
        resultado.push({ criterio, ok, medida });
      mkdirSync(PASTA as string, { recursive: true });
      const sufixo = `${nome}-passo${passo}${reduzido ? "-movimento-reduzido" : ""}`;
      const foto = (arquivo: string, cheia = true) =>
        page.screenshot({
          path: path.join(PASTA as string, `19-${arquivo}-${sufixo}.png`),
          fullPage: cheia,
        });

      await context.addCookies([
        { name: "escala-texto", value: passo, url: baseURL ?? "http://localhost" },
      ]);
      if (reduzido) await page.emulateMedia({ reducedMotion: "reduce" });
      await semear(nome);
      const console_ = vigiarConsole(page);
      await usarVozImediata(page);
      const email = emailDeTeste("visual19");
      await convidarParaTeste(email);
      await entrarPorLink(page, email);

      // ── Controles positivos dos medidores ──
      await page.goto(`/estudos/${ESTUDO_DA_VARREDURA}`);
      await esperarEstudoAssentado(page);
      const controle = await page.evaluate(() => {
        const d = document.createElement("div");
        d.id = "controle-largo";
        d.style.cssText = "width:2000px;height:4px";
        document.body.append(d);
        const sobra = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        d.remove();
        return sobra;
      });
      registrar(
        "controle (l): bloco de 2000 px faz a medida passar de 0",
        controle > 0,
        `sobra=${controle}`,
      );

      // ── Estudo P1: Passagem, parágrafo, ficha e as três juntas ──
      const botoes = page.locator('[data-slot="citacao-botao"]');
      const n = await botoes.count();
      registrar("(b) há quatro botões de Citação no Estudo da conferência", n === 4, `botões=${n}`);
      expect(await sobraHorizontal(page), "antes de abrir").toBeLessThanOrEqual(0);
      registrar(
        "(l) antes de abrir: sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra=${await sobraHorizontal(page)}`,
      );
      await foto("estudo-fechado");

      // (b) 44 px e aria-expanded, (k) primeiro clique, (a) console a cada abrir/fechar.
      for (let i = 0; i < n; i++) {
        const botao = botoes.nth(i);
        await esperarHidratado(botao);
        const altura = (await botao.boundingBox())?.height ?? 0;
        registrar(
          `(b) botão ${i + 1} mede pelo menos 44 px`,
          altura >= 44,
          `altura=${Math.round(altura)}`,
        );
        await botao.click(); // o PRIMEIRO clique
        const aberto = await botao.getAttribute("aria-expanded");
        registrar(
          `(k) botão ${i + 1}: o primeiro clique abre`,
          aberto === "true",
          `aria-expanded=${aberto}`,
        );
        const painel = page.locator('[data-slot="citacao-painel"]').nth(i);
        await expect(painel).toBeVisible();
        // (j) duração da abertura.
        const anim = await painel.evaluate((el) => {
          const c = getComputedStyle(el);
          return {
            nome: c.animationName,
            duracao: c.animationDuration,
            funcao: c.animationTimingFunction,
          };
        });
        if (reduzido) {
          const ms = Number.parseFloat(anim.duracao) * (anim.duracao.endsWith("ms") ? 1 : 1000);
          registrar(
            `(j) painel ${i + 1} sob movimento reduzido: ≤ 0,01 ms`,
            ms <= 0.01 + 1e-9,
            `animation-duration=${anim.duracao}`,
          );
        } else {
          registrar(
            `(j) painel ${i + 1}: abertura de 200 ms em --ease-leitura`,
            anim.nome === "citacao-abrir" &&
              anim.duracao === "0.2s" &&
              /cubic-bezier\(0\.2, 0, 0, 1\)/.test(anim.funcao),
            `${anim.nome} ${anim.duracao} ${anim.funcao}`,
          );
        }
      }
      await expect(page.locator('[data-slot="citacao-painel"]')).toHaveCount(n);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await foto("estudo-aberto");

      // (l) com os painéis abertos; texto cortado.
      const sobra = await sobraHorizontal(page);
      registrar(
        "(l) depois de abrir os quatro painéis: sem rolagem horizontal",
        sobra <= 0,
        `scrollWidth-clientWidth=${sobra}`,
      );
      const corte = await page.evaluate(medirCortados);
      // Diagnóstico: quem passa da borda direita do item da Citação.
      const culpados = await page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="citacao-item"]')].flatMap((item) => {
          const limite = item.getBoundingClientRect().right;
          return [...item.querySelectorAll("*")]
            .filter((e) => e.getBoundingClientRect().right > limite + 1)
            .map(
              (e) =>
                `${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").slice(0, 40)} right=${Math.round(e.getBoundingClientRect().right)} limite=${Math.round(limite)} texto=${(e.textContent ?? "").slice(0, 30)}`,
            );
        }),
      );
      registrar(
        "(l) nenhum texto cortado dentro de main e nenhum filho passa da borda do item da Citação",
        corte.length === 0 && culpados.length === 0,
        `cortados=${JSON.stringify(corte)} culpados=${JSON.stringify(culpados)}`,
      );

      // (d) painel na largura da coluna, abaixo do botão, sem cobrir texto.
      const geometria = await page.evaluate(() => {
        const janela = document.documentElement.clientWidth;
        return [...document.querySelectorAll('[data-slot="citacao"]')].map((c) => {
          const b = c.querySelector('[data-slot="citacao-botao"]')?.getBoundingClientRect();
          const p = c.querySelector('[data-slot="citacao-painel"]')?.getBoundingClientRect();
          const bloco = c.parentElement?.getBoundingClientRect();
          return {
            abaixo: p && b ? p.top >= b.bottom - 1 : false,
            dentroDoBloco:
              p && bloco ? p.left >= bloco.left - 1 && p.right <= bloco.right + 1 : false,
            dentroDaJanela: p ? p.right <= janela + 1 && p.left >= -1 : false,
          };
        });
      });
      registrar(
        "(d) cada painel abre abaixo do botão, dentro da largura do bloco e da janela",
        geometria.every((g) => g.abaixo && g.dentroDoBloco && g.dentroDaJanela),
        JSON.stringify(geometria),
      );

      // (e) lang dos trechos; (f) ficha; (g) Passagem.
      const idiomas = await page.evaluate(() => ({
        ingles: [...document.querySelectorAll('[data-alvo="paragrafo"] q')].map((q) =>
          q.getAttribute("lang"),
        ),
        passagem: [
          ...document.querySelectorAll('[data-alvo="passagem"] [data-slot="trecho-citado"]'),
        ].map((q) => q.getAttribute("lang")),
      }));
      registrar(
        "(e) trecho de Fonte em inglês com lang=en e de Passagem com lang=pt-BR",
        idiomas.ingles.length > 0 &&
          idiomas.ingles.every((l) => l === "en") &&
          idiomas.passagem.length > 0 &&
          idiomas.passagem.every((l) => l === "pt-BR"),
        JSON.stringify(idiomas),
      );
      const ficha = await page.evaluate(() => {
        const f = document.querySelector('[data-alvo="ficha"]');
        return {
          texto: f?.textContent ?? "",
          fonte: f?.querySelector('[data-slot="citacao-fonte"]')?.textContent ?? "",
        };
      });
      registrar(
        "(f) ficha: 'Trecho da ficha, p. {n} de {obra}', 'Verificada em' e nunca 'leia o livro'",
        /^Trecho da ficha, p\. \d/.test(ficha.fonte) &&
          / de Obra de Teste Completa$/.test(ficha.fonte) &&
          /Verificada em \d{1,2} de \p{L}+ de \d{4}\./u.test(ficha.texto) &&
          !/leia o livro/i.test(ficha.texto),
        `${ficha.fonte} | ${/Verificada em[^.]*\./.exec(ficha.texto)?.[0] ?? "sem data"}`,
      );
      const passagem = await page.evaluate(() => {
        const p = document.querySelector('[data-alvo="passagem"]');
        return {
          links: p?.querySelectorAll("a").length ?? -1,
          texto: p?.querySelector('[data-slot="trecho-citado"]')?.textContent ?? "",
        };
      });
      registrar(
        "(g) Passagem sem link e com o texto da Bíblia Livre",
        passagem.links === 0 && passagem.texto.trim().length > 10,
        `links=${passagem.links} texto=${passagem.texto.trim().slice(0, 40)}`,
      );

      // (c) o par em cinza: contorno × preenchimento, pontos contados, contraste do ponto cheio.
      const pares = await page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="citacao-botao"]')].map((b) => {
          const nivel = b.querySelector('[data-slot="selo-nivel"]') as HTMLElement;
          const grau = b.querySelector('[data-slot="selo-grau"]') as HTMLElement;
          const cheio = grau.querySelector('[data-ponto="cheio"]') as HTMLElement | null;
          const cn = getComputedStyle(nivel);
          const cg = getComputedStyle(grau);
          return {
            grau: grau.dataset.grau,
            cheios: grau.querySelectorAll('[data-ponto="cheio"]').length,
            vazados: grau.querySelectorAll('[data-ponto="vazado"]').length,
            contornoDoNivel: cn.borderTopWidth,
            contornoDoGrau: cg.borderTopWidth,
            preenchimentoDoNivel: cn.backgroundColor,
            preenchimentoDoGrau: cg.backgroundColor,
            pontoCheio: cheio ? getComputedStyle(cheio).backgroundColor : "",
            palavra: grau.textContent?.trim() ?? "",
          };
        }),
      );
      const esperado: Record<string, [number, number]> = {
        consenso: [3, 0],
        "posicao-majoritaria": [2, 1],
        disputada: [1, 2],
      };
      const distintos = new Set(pares.map((p) => p.grau));
      registrar(
        "(c) Nível com contorno de 1 px e sem preenchimento; Grau sem contorno e com preenchimento; pontos 3/2/1 e palavra presente",
        pares.every((p) => {
          const e = esperado[p.grau ?? ""];
          return (
            p.contornoDoNivel === "1px" &&
            p.contornoDoGrau === "0px" &&
            p.preenchimentoDoGrau !== "rgba(0, 0, 0, 0)" &&
            (p.preenchimentoDoNivel === "rgba(0, 0, 0, 0)" ||
              p.preenchimentoDoNivel === "transparent") &&
            e !== undefined &&
            p.cheios === e[0] &&
            p.vazados === e[1] &&
            p.palavra.length > 3
          );
        }) && distintos.size === 3,
        JSON.stringify(
          pares.map((p) => [p.grau, p.cheios, p.vazados, p.contornoDoNivel, p.contornoDoGrau]),
        ),
      );
      const um = pares[0];
      if (um) {
        const c = contrasteEmCinza(lerRgb(um.pontoCheio), lerRgb(um.preenchimentoDoGrau));
        registrar(
          "(c) ponto cheio contra o fundo do selo, em cinza: ≥ 3:1",
          c >= 3,
          `contraste=${c.toFixed(2)}`,
        );
      }
      await page.addStyleTag({ content: "html{filter:grayscale(1)}" });
      await foto("estudo-aberto-cinza", false);
      await page.evaluate(() => {
        for (const s of document.querySelectorAll("style")) {
          if (s.textContent === "html{filter:grayscale(1)}") s.remove();
        }
      });

      // Fechar de volta: aria-expanded e painel somem.
      for (let i = 0; i < n; i++) {
        await botoes.nth(i).click();
        await expect(botoes.nth(i)).toHaveAttribute("aria-expanded", "false");
      }
      registrar(
        "(b) fechar devolve aria-expanded=false e tira o painel",
        (await page.locator('[data-slot="citacao-painel"]').count()) === 0,
        "painéis=0",
      );

      // (i) a voz não lê o botão nem o painel (as fontes de fala são o Markdown, e o botão nunca está no bloco falado).
      await instalarFalaFalsa(page, { vozes: [VOZ_PT_BR] });
      await page.goto(`/estudos/${ESTUDO_DA_VARREDURA}`);
      await esperarEstudoAssentado(page);
      const ouvir = page.locator('[data-ouvir="estudo"] button').first();
      await esperarHidratado(ouvir);
      await ouvir.click();
      await expect(ouvir).toHaveText("Pausar");
      const fala = (await estadoDaFala(page)).enfileiradas.join(" ");
      const proibidas = [
        "Mostrar a Citação",
        "Esconder a Citação",
        "Grau de certeza:",
        "Trecho da ficha",
        "Ler na Fonte",
        "Ver a ficha de",
        "Bíblia Livre,",
        "Trecho em inglês",
        "Obra de Teste",
        "Now there was about this time",
        "O que são os dois selos",
      ];
      const lidas = proibidas.filter((p) => fala.includes(p));
      const dentro = await page.locator('[data-ouvir] [data-slot="citacao"]').count();
      registrar(
        "(i) a fala não traz nenhuma palavra do botão nem do painel",
        lidas.length === 0 && fala.length > 50 && dentro === 0,
        `proibidas lidas=${JSON.stringify(lidas)} fala=${fala.length} caracteres; citações dentro do controle de voz=${dentro}`,
      );
      await ouvir.click().catch(() => {});

      // ── Estudo P2: capitular e Afirmações sem Citação ──
      await page.goto(`/estudos/${ESTUDO_DA_CAPITULAR}`);
      await esperarEstudoAssentado(page);
      const capitular = await page.evaluate(() => {
        const botao = document.querySelector(
          '[data-citacao-de="bh05-a1"] [data-slot="citacao-botao"]',
        );
        const p = botao?.closest("p");
        if (!botao || !p) return null;
        const intervalo = document.createRange();
        const texto = [...p.childNodes]
          .filter((nn) => nn.nodeType === 3 || (nn as Element).tagName === "SPAN")
          .slice(0, -1);
        const ultimo = texto.at(-1);
        if (ultimo) intervalo.selectNodeContents(ultimo);
        const fimDoTexto = intervalo.getBoundingClientRect().bottom;
        const b = botao.getBoundingClientRect();
        const letra = getComputedStyle(p, "::first-letter");
        return {
          botaoTopo: b.top,
          fimDoTexto,
          letraFlutuante: letra.float,
          temCapitular: letra.float === "left",
          largura: p.getBoundingClientRect().width,
          paiOverflow: getComputedStyle(p).display,
        };
      });
      registrar(
        "(d) capitular: o botão vem abaixo do último trecho de texto do parágrafo",
        capitular !== null &&
          capitular.temCapitular &&
          capitular.botaoTopo + 1 >= capitular.fimDoTexto,
        JSON.stringify(capitular),
      );
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="chip-fonte"]')].map((c) => ({
          estilo: getComputedStyle(c).borderTopStyle,
          papel: c.getAttribute("role"),
          foco: (c as HTMLElement).tabIndex,
          texto: c.textContent,
        })),
      );
      registrar(
        "(h) as Afirmações sem Citação mostram o chip tracejado 'Fonte em preparação', sem papel e fora do foco",
        chips.length >= 3 &&
          chips.every(
            (c) =>
              c.estilo === "dashed" &&
              c.papel === null &&
              c.foco === -1 &&
              /^Fonte em preparação/.test(c.texto ?? ""),
          ),
        `chips=${chips.length}`,
      );
      await page.locator('[data-slot="citacao-botao"]').first().click();
      await expect(page.locator('[data-slot="citacao-painel"]')).toHaveCount(1);
      registrar(
        "(l) capitular com o painel aberto: sem rolagem horizontal",
        (await sobraHorizontal(page)) <= 0,
        `sobra=${await sobraHorizontal(page)}`,
      );
      await foto("capitular-aberta");

      // ── Retaguardas ──
      // Alto contraste forçado, por emulação: ponto cheio e vazado diferem no preenchimento.
      await page.emulateMedia({
        forcedColors: "active",
        ...(reduzido ? { reducedMotion: "reduce" as const } : {}),
      });
      const forcado = await page.evaluate(() => {
        const g = document.querySelector('[data-slot="selo-grau"]');
        const cheio = g?.querySelector('[data-ponto="cheio"]');
        const vazado = g?.querySelector('[data-ponto="vazado"]');
        const c = (e: Element | null | undefined) => (e ? getComputedStyle(e) : null);
        return {
          cheio: c(cheio)?.backgroundColor ?? "",
          vazado: c(vazado)?.backgroundColor ?? "",
          bordaVazado: c(vazado)?.borderTopColor ?? "",
          achou: Boolean(cheio && vazado),
        };
      });
      await foto("forcado", false);
      registrar(
        "retaguarda: pontos do SeloGrau em forced-colors (EMULADO no Chromium, não o Windows real)",
        forcado.achou && forcado.cheio !== forcado.vazado,
        JSON.stringify(forcado),
      );
      await page.emulateMedia({ forcedColors: "none" });

      // (a) console limpo na sessão toda.
      registrar(
        "(a) nenhum aviso de hidratação, validateDOMNesting nem 'cannot be a descendant'",
        console_.length === 0,
        `avisos=${JSON.stringify(console_)}`,
      );

      writeFileSync(
        path.join(PASTA as string, `19-${sufixo}.json`),
        JSON.stringify({ projeto: nome, passo, reduzido, largura, resultado }, null, 2),
      );
      const falhas = resultado.filter((l) => !l.ok);
      expect(falhas, JSON.stringify(falhas, null, 1)).toEqual([]);
    });
  }
}
