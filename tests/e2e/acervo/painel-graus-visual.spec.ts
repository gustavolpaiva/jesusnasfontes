import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect as esperar, type Page, test } from "@playwright/test";
import {
  mudarTextoDaAfirmacao,
  removerPropostas,
  restaurarTextoDaAfirmacao,
  semearPropostas,
} from "../../support/citacao-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";

// Conferência RENDERIZADA do painel de graus propostos (plano 02-21; rule `visual-verification-gate`). Roda só com
// `VISUAL_DIR` (pasta das capturas e das medições) e com UM processo (`--workers=1`: cada projeto semeia e remove as
// mesmas Afirmações). O critério (a a h) está escrito ANTES de olhar, em `.planning/phases/02-acervo/visual/21-painel-graus.md`;
// este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/painel-graus-visual.spec.ts --workers=1

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });
// Os projetos de varredura caem todos nas mesmas Afirmações (só `celular` e `computador` têm Estudos próprios): com mais de um
// processo eles se disputam a semeadura e a falha aparece como restrição única, longe da causa. Falha logo, dizendo o porquê.
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  if (PASTA && info.config.workers > 1)
    throw new Error(
      "painel-graus-visual: rode com --workers=1 (cada projeto semeia e remove as mesmas Afirmações)",
    );
});
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): sob a carga de vários processos o padrão de 5 s dá falso vermelho.
const expect = esperar.configure({ timeout: 30000 });

type Linha = { criterio: string; ok: boolean; medida: string };
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
const cortados = (page: Page) => page.evaluate(medirCortados, "main");

async function cortadosComControle(page: Page): Promise<{ antes: number; com: number }> {
  const antes = await cortados(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "controle-texto-cortado";
    d.textContent = "textosemnenhumpontodequebranemmesmocomalgumaboavontade";
    d.style.cssText = "width:40px;white-space:nowrap;overflow:hidden";
    document.querySelector("main")?.append(d);
  });
  const com = await cortados(page);
  await page.evaluate(() => document.getElementById("controle-texto-cortado")?.remove());
  return { antes, com };
}

const itemDe = (page: Page, id: string) =>
  page.locator(`[data-slot="accordion-item"][data-afirmacao="${id}"]`);

async function abrir(page: Page, id: string) {
  const item = itemDe(page, id);
  const gatilho = item.locator('[data-slot="proposta-gatilho"]');
  await esperarHidratado(gatilho);
  await gatilho.click();
  await expect(gatilho).toHaveAttribute("aria-expanded", "true");
  // A abertura do acordeão leva 200 ms: espera o fim antes de medir e de capturar.
  await page.waitForTimeout(450);
  return item;
}

for (const variante of ["projeto", "390-claro"] as const) {
  test(`@varredura painel de graus${variante === "projeto" ? "" : " (390-claro)"}`, async ({
    page,
  }, info) => {
    test.setTimeout(300_000);
    if (variante === "390-claro") {
      test.skip(info.project.name !== "varredura-390-escuro", "variante só no projeto de 390 px");
      await page.emulateMedia({ colorScheme: "light" });
    }
    const nome = variante === "390-claro" ? "varredura-390-claro" : info.project.name;
    const resultado: Linha[] = [];
    const registrar = (criterio: string, ok: boolean, medida: string) =>
      resultado.push({ criterio, ok, medida });
    mkdirSync(PASTA as string, { recursive: true });
    const foto = (arquivo: string, cheia = true) =>
      page.screenshot({
        path: path.join(PASTA as string, `21-${arquivo}-${nome}.png`),
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

    const semeado = await semearPropostas(`vis21-${nome}`);
    const a = semeado.afirmacoes;
    let original: string | null = null;
    try {
      await entrarComoAdmin(page, `visual21-${nome}`);
      await page.goto("/admin/acervo/graus?filtro=todas");
      await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
      await esperarHidratado(page.locator('[data-slot="proposta-gatilho"]').first());

      // ── Controles positivos dos medidores ──
      const controle = await page.evaluate(() => {
        const b = document.createElement("button");
        b.style.cssText = "height:30px;width:30px";
        document.body.append(b);
        const alvo = b.getBoundingClientRect().height;
        b.remove();
        const c = document.createElement("button");
        let n = 0;
        let efeito = false;
        c.addEventListener("click", () => {
          n += 1;
          if (n === 2) efeito = true;
        });
        document.body.append(c);
        c.click();
        const aposUm = efeito;
        c.remove();
        const p = document.createElement("p");
        p.style.cssText = "width:120px;line-height:20px";
        p.textContent = "palavra ".repeat(40);
        document.body.append(p);
        const linhas = Math.round(p.getBoundingClientRect().height / 20);
        p.remove();
        return { alvo, aposUm, linhas };
      });
      const corte = await cortadosComControle(page);
      registrar(
        "g: controle positivo, o MESMO medidor de texto cortado acusa o bloco inserido em main",
        corte.com === corte.antes + 1,
        `${corte.antes} cortados antes do controle, ${corte.com} com ele`,
      );
      registrar(
        "a/f: controle positivo, o medidor de altura mínima acusa botão de 30 px, e o de linhas vê um bloco longo",
        controle.alvo < 44 && controle.linhas > 3,
        `${controle.alvo} px; ${controle.linhas} linhas`,
      );
      registrar(
        "h: controle positivo, o medidor de primeiro clique acusa botão que só reage ao segundo",
        controle.aposUm === false,
        `efeito depois de 1 clique: ${controle.aposUm}`,
      );

      // ── (a) gatilho e (d) chips, na lista fechada ──
      const gatilhos = await page.locator('[data-slot="proposta-gatilho"]').evaluateAll((els) =>
        els.map((g) => {
          const frase = g.querySelector(".frase-do-gatilho") as HTMLElement;
          const css = getComputedStyle(frase);
          const linha = Number.parseFloat(css.lineHeight);
          const chip = g.querySelector('[data-slot="chip-estado"]') as HTMLElement;
          const chipCss = getComputedStyle(chip);
          return {
            altura: Math.round(g.getBoundingClientRect().height),
            linhas: Math.round(frase.getBoundingClientRect().height / linha),
            clamp: css.getPropertyValue("-webkit-line-clamp"),
            temMeta: /·/.test(g.textContent ?? ""),
            chip: {
              texto: (chip.textContent ?? "").trim(),
              estilo: chipCss.borderTopStyle,
              largura: chipCss.borderTopWidth,
              cor: chipCss.borderTopColor,
              icone: chip.querySelector("svg") !== null,
            },
            papel: getComputedStyle(document.body).backgroundColor,
          };
        }),
      );
      registrar(
        "a: todo gatilho com altura ≥ 56 px, frase com no máximo 3 linhas (line-clamp 3) e o meta '{Estudo} · {id}' dentro dele",
        gatilhos.length >= 7 &&
          gatilhos.every((g) => g.altura >= 56 && g.linhas <= 3 && g.clamp === "3" && g.temMeta),
        gatilhos.map((g) => `${g.altura}px/${g.linhas}l`).join(", "),
      );
      const assinatura = (c: (typeof gatilhos)[number]["chip"]) =>
        `${c.estilo}|${c.largura}|${c.icone ? "icone" : "sem"}`;
      const porPalavra = (inicio: string) =>
        gatilhos.find((g) => g.chip.texto.startsWith(inicio))?.chip;
      const quatro = ["Pendente", "Aprovada: ", "Aguardando ficha", "Texto mudou"].map(porPalavra);
      const formas = quatro.map((c) => (c ? assinatura(c) : "?"));
      const contrastes = gatilhos.map((g) => contrasteEmCinza(lerRgb(g.chip.cor), lerRgb(g.papel)));
      registrar(
        "d: quatro palavras diferentes; Pendente, Aprovada e Atenção com formas diferentes; borda ≥ 3:1 em cinza",
        quatro.every(Boolean) &&
          new Set(quatro.map((c) => c?.texto)).size === 4 &&
          new Set([formas[0], formas[1], formas[2]]).size === 3 &&
          formas[2] === formas[3] &&
          Math.min(...contrastes) >= 3,
        `${quatro.map((c) => c?.texto).join(" / ")}; formas ${formas.join(" · ")}; menor contraste ${Math.min(...contrastes).toFixed(2)}:1`,
      );
      registrar(
        "d: controle positivo, os dois chips de atenção (tracejado com ícone) dão a mesma assinatura (a assinatura enxerga forma)",
        formas[2] === formas[3] && formas[2] !== formas[0],
        `${formas[2]} = ${formas[3]}`,
      );
      registrar(
        "g: lista fechada sem rolagem horizontal e sem bloco cortado",
        (await sobraHorizontal(page)) <= 0 && (await cortados(page)) === 0,
        `sobra ${await sobraHorizontal(page)}px, ${await cortados(page)} cortados`,
      );
      await foto("lista");
      await cinza("lista");

      // ── (h) primeiro clique no gatilho; abre Passagem, Fonte e ficha ──
      const gatilhoCorrigir = itemDe(page, a.corrigir).locator('[data-slot="proposta-gatilho"]');
      await esperarHidratado(gatilhoCorrigir);
      await gatilhoCorrigir.click();
      const abriuComUm = (await gatilhoCorrigir.getAttribute("aria-expanded")) === "true";
      registrar(
        "h: UM clique no gatilho, logo depois da hidratação, abre a proposta",
        abriuComUm,
        `aria-expanded=${await gatilhoCorrigir.getAttribute("aria-expanded")}`,
      );
      await page.waitForTimeout(450);
      const corrigir = itemDe(page, a.corrigir);
      await abrir(page, a.aprovar);
      await abrir(page, a.ficha);

      // ── (e) trecho em <q lang> ──
      const qs = await page.locator('[data-slot="citacao-proposta"] q').evaluateAll((els) =>
        els.map((q) => {
          const css = getComputedStyle(q);
          return {
            lang: q.getAttribute("lang"),
            filhos: q.children.length,
            filete: css.borderLeftWidth,
            texto: (q.textContent ?? "").slice(0, 40),
          };
        }),
      );
      registrar(
        "e: todo trecho em <q> com lang en ou pt-BR, sem elemento dentro (a marcação do trecho entra como texto), filete de 2 px; o de Fonte é en",
        qs.length >= 2 &&
          qs.every(
            (q) => (q.lang === "en" || q.lang === "pt-BR") && q.filhos === 0 && q.filete === "2px",
          ) &&
          qs.some((q) => q.lang === "en"),
        JSON.stringify(qs),
      );

      // ── (b) grupo de escolha ──
      const assinaturasDoGrupo = () =>
        corrigir.locator('[data-slot="grau-opcao"]').evaluateAll((els) =>
          els.map((o) => {
            const css = getComputedStyle(o);
            return {
              palavra: (o.textContent ?? "").trim(),
              cheios: o.querySelectorAll('[data-ponto="cheio"]').length,
              vazados: o.querySelectorAll('[data-ponto="vazado"]').length,
              borda: css.borderTopWidth,
              cor: css.borderTopColor,
              check: o.querySelector("svg") !== null,
              marcado: o.getAttribute("aria-checked") === "true",
              papel: getComputedStyle(document.body).backgroundColor,
            };
          }),
        );
      const g1 = await assinaturasDoGrupo();
      const marcadoAntes = g1.findIndex((o) => o.marcado);
      const bMarcada = g1[marcadoAntes];
      const contrasteMarcada = bMarcada
        ? contrasteEmCinza(lerRgb(bMarcada.cor), lerRgb(bMarcada.papel))
        : 0;
      const estruturaOk =
        g1.length === 3 &&
        new Set(g1.map((o) => o.palavra)).size === 3 &&
        JSON.stringify(g1.map((o) => o.cheios)) === "[3,2,1]" &&
        g1.every((o) => o.cheios + o.vazados === 3) &&
        g1.filter((o) => o.marcado).length === 1 &&
        g1.every((o) =>
          o.marcado ? o.borda === "2px" && o.check : o.borda === "1px" && !o.check,
        ) &&
        contrasteMarcada >= 3;
      // Um clique na opção "Disputada": a assinatura "marcada" se move, e o rótulo do botão muda.
      const aprovarCorrigir = corrigir.locator('[data-slot="aprovar-grau"]');
      const rotuloAntes = (await aprovarCorrigir.textContent())?.trim();
      await corrigir.getByRole("radio", { name: "Disputada" }).click();
      const g2 = await assinaturasDoGrupo();
      const rotuloDepois = (await aprovarCorrigir.textContent())?.trim();
      const moveu = g2.findIndex((o) => o.marcado) === 2 && g2[2]?.borda === "2px" && g2[2]?.check;
      registrar(
        "b: três palavras, pontos cheios 3/2/1, marcada com borda de 2 px e check (as outras 1 px sem), contraste da borda marcada ≥ 3:1 em cinza",
        estruturaOk,
        `${JSON.stringify(g1.map((o) => [o.palavra, o.cheios, o.borda, o.check, o.marcado]))}; contraste ${contrasteMarcada.toFixed(2)}:1`,
      );
      registrar(
        "b/h: UM clique em outra opção move a assinatura 'marcada' para ela e o botão passa de 'Aprovar este grau' a 'Aprovar o grau corrigido'",
        moveu === true &&
          rotuloAntes === "Aprovar este grau" &&
          rotuloDepois === "Aprovar o grau corrigido",
        `${rotuloAntes} → ${rotuloDepois}; marcada agora: ${g2.findIndex((o) => o.marcado)}`,
      );

      // ── (f) alvos de 44 px ──
      const alvos = await page.evaluate(() => {
        const medir = (seletor: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(seletor)).map((e) => {
            const r = e.getBoundingClientRect();
            return { h: Math.round(r.height), w: Math.round(r.width) };
          });
        return {
          radios: medir('[data-slot="grau-opcao"]'),
          botoes: medir('[data-slot="aprovar-grau"]'),
          links: medir('[data-slot="proposta-grau"] a'),
          filtros: medir('[data-slot="filtro-graus-item"]'),
          mais: medir('[data-slot="mais-propostas"]'),
        };
      });
      const todos = [
        ...alvos.radios,
        ...alvos.botoes,
        ...alvos.links,
        ...alvos.filtros,
        ...alvos.mais,
      ];
      registrar(
        "f: radios, botão de aprovar, 'Ver no Estudo' e filtros com altura ≥ 44 px; radios e botão também com largura ≥ 44 px",
        alvos.radios.length >= 9 &&
          todos.every((t) => t.h >= 44) &&
          [...alvos.radios, ...alvos.botoes].every((t) => t.w >= 44),
        `radios ${alvos.radios.map((t) => `${t.w}x${t.h}`).join(",")}; botões ${alvos.botoes.map((t) => `${t.w}x${t.h}`).join(",")}; links ${alvos.links.map((t) => t.h).join(",")}; filtros ${alvos.filtros.map((t) => t.h).join(",")}`,
      );
      registrar(
        "g: propostas abertas sem rolagem horizontal e sem bloco cortado",
        (await sobraHorizontal(page)) <= 0 && (await cortados(page)) === 0,
        `sobra ${await sobraHorizontal(page)}px, ${await cortados(page)} cortados`,
      );
      await foto("abertas");
      await cinza("abertas");

      // ── (h) foco visível por teclado: gatilho, radio e botão ──
      const foco = async (seletor: string) => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        // Vai ao elemento por Tab a partir do gatilho do item (o teclado de verdade, que liga :focus-visible).
        await corrigir.locator('[data-slot="proposta-gatilho"]').focus();
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, seletor))
            break;
        }
        return page.evaluate((s) => {
          const e = document.activeElement as HTMLElement;
          const css = getComputedStyle(e);
          return {
            acertou: e.matches(s),
            estilo: css.outlineStyle,
            largura: Number.parseFloat(css.outlineWidth),
          };
        }, seletor);
      };
      const focos = {
        radio: await foco('[data-slot="grau-opcao"]'),
        botao: await foco('[data-slot="aprovar-grau"]'),
      };
      await corrigir.locator('[data-slot="proposta-gatilho"]').focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const focoGatilho = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const css = getComputedStyle(e);
        return {
          acertou: e.matches('[data-slot="proposta-gatilho"]'),
          estilo: css.outlineStyle,
          largura: Number.parseFloat(css.outlineWidth),
        };
      });
      registrar(
        "h: gatilho, radio e botão de aprovar mostram contorno de foco (outline-style ≠ none, largura ≥ 2 px) quando alcançados por Tab",
        [focos.radio, focos.botao, focoGatilho].every(
          (f) => f.acertou && f.estilo !== "none" && f.largura >= 2,
        ),
        JSON.stringify({ radio: focos.radio, botao: focos.botao, gatilho: focoGatilho }),
      );

      // ── (c) Aguardando ficha, aberta ──
      await abrir(page, a.aguardando);
      const aguardando = itemDe(page, a.aguardando);
      await aguardando.scrollIntoViewIfNeeded();
      const c = await page.evaluate((id) => {
        const botao = document.querySelector(
          `[data-afirmacao="${id}"] [data-slot="aprovar-grau"]`,
        ) as HTMLButtonElement;
        botao.focus();
        const alvoDescrito = botao.getAttribute("aria-describedby");
        const motivo = alvoDescrito ? document.getElementById(alvoDescrito) : null;
        const r = motivo?.getBoundingClientRect();
        return {
          desabilitado: botao.disabled,
          ariaDisabled: botao.getAttribute("aria-disabled"),
          tabindex: botao.tabIndex,
          focado: document.activeElement === botao,
          motivo: motivo?.textContent?.trim() ?? "",
          motivoVisivel: r ? r.width > 0 && r.height > 0 : false,
          dentro: r ? r.left >= 0 && r.right <= window.innerWidth : false,
        };
      }, a.aguardando);
      registrar(
        "c: botão não é disabled, aria-disabled=true, recebe foco; o motivo 'Falta verificar a ficha de …' é o aria-describedby, visível e dentro da janela",
        !c.desabilitado &&
          c.ariaDisabled === "true" &&
          c.tabindex >= 0 &&
          c.focado &&
          /^Falta verificar a ficha de .+\.$/.test(c.motivo) &&
          c.motivoVisivel &&
          c.dentro,
        JSON.stringify(c),
      );
      await foto("aguardando");
      await cinza("aguardando");

      // ── (g) com a recusa do banco à mostra (o texto muda entre a leitura e o clique) ──
      await abrir(page, a.corrida);
      original = await mudarTextoDaAfirmacao(a.corrida);
      await itemDe(page, a.corrida).locator('[data-slot="aprovar-grau"]').click();
      const recusa = itemDe(page, a.corrida)
        .locator('[data-slot="recusa-do-grau"]')
        .getByRole("alert");
      await expect(recusa).toContainText(
        "Esta frase mudou depois da proposta. Recarregue as propostas.",
      );
      const r = await page.evaluate(() => {
        const alerta = document.querySelector(
          '[data-slot="recusa-do-grau"] [role="alert"]',
        ) as HTMLElement;
        const botao = alerta.querySelector("button") as HTMLElement;
        const rb = botao.getBoundingClientRect();
        const ra = alerta.getBoundingClientRect();
        return {
          alvo: Math.round(rb.height),
          dentro: ra.left >= 0 && ra.right <= window.innerWidth,
          texto: botao.textContent?.trim(),
        };
      });
      registrar(
        "g/f: recusa à mostra sem rolagem horizontal, com 'Recarregar as propostas' de ≥ 44 px dentro da janela",
        (await sobraHorizontal(page)) <= 0 &&
          (await cortados(page)) === 0 &&
          r.alvo >= 44 &&
          r.dentro &&
          r.texto === "Recarregar as propostas",
        `sobra ${await sobraHorizontal(page)}px; ${await cortados(page)} cortados; ${JSON.stringify(r)}`,
      );
      await foto("recusa");
    } finally {
      if (original) {
        await restaurarTextoDaAfirmacao(a.corrida, original);
      }
      await removerPropostas(semeado);
    }

    writeFileSync(
      path.join(PASTA as string, `21-painel-graus-${nome}.json`),
      JSON.stringify(resultado, null, 2),
    );
    const reprovadas = resultado.filter((l) => !l.ok);
    expect(reprovadas, JSON.stringify(reprovadas, null, 2)).toEqual([]);
  });
}
