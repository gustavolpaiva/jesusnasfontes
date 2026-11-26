import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect as esperar, type Page, test } from "@playwright/test";
import {
  removerFichas,
  removerFichasParaConferir,
  semearFichas,
  semearFichasParaConferir,
} from "../../support/ficha-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import { escrever } from "../../support/login-e2e";
import { conferirParaTeste } from "../../support/verificar-ficha-teste";

// Conferência RENDERIZADA do painel de fichas do Admin (plano 02-18; rule `visual-verification-gate`). Roda só com
// `VISUAL_DIR` (pasta das capturas e das medições). O critério (a a i) está escrito ANTES de olhar, em
// `.planning/phases/02-acervo/visual/18-painel-fichas.md`; este arquivo só o mede.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/acervo/painel-fichas-visual.spec.ts

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): é ELE que o arquivo usa.
const expect = esperar.configure({ timeout: 15_000 });

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

// O medidor do critério g: conta, dentro de `raiz`, os elementos cujo conteúdo é mais largo que a caixa. Texto CORTADO
// (`overflow:hidden`, com ou sem reticências) conta como falha: é justamente o corte que esconde texto. Só ficam de fora
// os blocos que rolam de propósito (`overflow-x: auto|scroll`: o conteúdo continua alcançável), o que é inline e o que é
// só para leitor de tela. É UMA função só: a medição real e o controle positivo passam por ela (o `page.evaluate` a
// serializa, então ela não pode usar nada de fora do próprio corpo).
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

/** Controle positivo do critério g: insere em `main` um texto cortado (largura 40 px, sem quebra, `overflow:hidden`) e roda o MESMO medidor. */
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

let sufixo = "";
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = `vis18-${info.project.name}`;
});
test.afterAll(async () => {
  if (!sufixo) return;
  for (const s of [sufixo, `${sufixo}-c`]) {
    await removerFichas(s);
    await removerFichasParaConferir(s);
  }
});

for (const variante of ["projeto", "390-claro"] as const) {
  test(`@varredura painel de fichas${variante === "projeto" ? "" : " (390-claro)"}`, async ({
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
        path: path.join(PASTA as string, `18-${arquivo}-${nome}.png`),
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

    // ── Semente: verificada, alterada, rascunho; em conferência (2 de 4), pronta (uma página) ──
    const sufixoDaVez = `${sufixo}${variante === "390-claro" ? "-c" : ""}`;
    await semearFichas(sufixoDaVez);
    const fichas = await semearFichasParaConferir(sufixoDaVez);
    await conferirParaTeste(process.env, fichas.conferir, 2);
    await conferirParaTeste(process.env, fichas.umapagina);
    const admin = await entrarComoAdmin(page, `visual18-${nome}`);

    // ── Controles positivos dos medidores ──
    await page.goto("/admin/acervo/fichas");
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
      return { alvo, aposUm };
    });
    const corte = await cortadosComControle(page);
    registrar(
      "g: controle positivo, o MESMO medidor de texto cortado (também o de overflow:hidden) acusa o bloco inserido em main",
      corte.com === corte.antes + 1,
      `${corte.antes} cortados antes do controle, ${corte.com} com ele`,
    );
    registrar(
      "d: controle positivo, o medidor de alvo acusa botão de 30 px",
      controle.alvo < 44,
      `${controle.alvo} px`,
    );
    registrar(
      "h: controle positivo, o medidor de primeiro clique acusa botão que só reage ao segundo",
      controle.aposUm === false,
      `efeito depois de 1 clique: ${controle.aposUm}`,
    );

    // ── Fila ──
    await expect(page.getByRole("heading", { level: 1, name: "Fichas a verificar" })).toBeVisible();
    const chips = await page.locator('[data-slot="linha-ficha-admin"]').evaluateAll((linhas) =>
      linhas.map((l) => {
        const chip = l.querySelector('[data-slot="chip-estado"]') as HTMLElement;
        const css = getComputedStyle(chip);
        return {
          estado: l.getAttribute("data-estado"),
          texto: (chip.textContent ?? "").trim(),
          estilo: css.borderTopStyle,
          largura: css.borderTopWidth,
          cor: css.borderTopColor,
          icone: chip.querySelector("svg") !== null,
          papel: getComputedStyle(document.body).backgroundColor,
        };
      }),
    );
    const porEstado = new Map(chips.map((c) => [c.estado, c]));
    const assinatura = (c: (typeof chips)[number] | undefined) =>
      c ? `${c.estilo}|${c.largura}|${c.icone ? "icone" : "sem"}` : "?";
    const cincoEstados = ["pronta", "em-conferencia", "rascunho", "alterada", "verificada"];
    const palavras = cincoEstados.map((e) => porEstado.get(e)?.texto ?? "?");
    const formas = [
      assinatura(porEstado.get("pronta")),
      assinatura(porEstado.get("verificada")),
      assinatura(porEstado.get("alterada")),
      assinatura(porEstado.get("rascunho")),
    ];
    const tracejadosIguais =
      assinatura(porEstado.get("rascunho")) === assinatura(porEstado.get("em-conferencia"));
    const contrastes = chips.map((c) => contrasteEmCinza(lerRgb(c.cor), lerRgb(c.papel)));
    registrar(
      "a: cinco palavras diferentes; Pronta, Verificada e Alterada com forma diferente entre si e dos tracejados sem ícone; borda ≥ 3:1 em cinza",
      new Set(palavras).size === 5 &&
        new Set(formas).size === 4 &&
        Math.min(...contrastes) >= 3 &&
        chips.length >= 5,
      `${palavras.join(" / ")}; formas ${formas.join(" · ")}; menor contraste ${Math.min(...contrastes).toFixed(2)}:1`,
    );
    registrar(
      "a: controle positivo, os dois tracejados sem ícone têm a mesma assinatura (a assinatura enxerga forma)",
      tracejadosIguais,
      `${assinatura(porEstado.get("rascunho"))} = ${assinatura(porEstado.get("em-conferencia"))}`,
    );
    const textosFila = await page.locator('[data-slot="linha-ficha-admin"]').allInnerTexts();
    registrar(
      "f: a fila mostra o progresso em texto ('2 de 4 páginas conferidas', '1 de 1 página conferida')",
      textosFila.some((t) => t.includes("2 de 4 páginas conferidas")) &&
        textosFila.some((t) => t.includes("1 de 1 página conferida")),
      textosFila
        .map((t) => t.replace(/\n+/g, " | "))
        .join(" ;; ")
        .slice(0, 400),
    );
    registrar(
      "g: fila sem rolagem horizontal e sem bloco cortado",
      (await sobraHorizontal(page)) <= 0 && (await cortados(page)) === 0,
      `sobra ${await sobraHorizontal(page)}px, ${await cortados(page)} cortados`,
    );
    const alvosFila = await page
      .locator('[data-slot="linha-ficha-admin"] a')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    registrar(
      "d: links da fila com altura ≥ 44 px",
      alvosFila.length >= 5 && alvosFila.every((h) => h >= 44),
      alvosFila.join(", "),
    );
    await foto("fila");
    await cinza("fila");

    // ── Detalhe: em conferência (2 de 4) ──
    await page.goto(`/admin/acervo/fichas/${fichas.conferir}`);
    const verificar = page.getByRole("button", { name: "Marcar como verificada", exact: true });
    await esperarHidratado(verificar);

    // (b) botão focável com o motivo em texto
    const b = await page.evaluate(() => {
      const botao = document.querySelector('[data-slot="verificar-botao"]') as HTMLButtonElement;
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
      };
    });
    registrar(
      "b: não é disabled; aria-disabled=true; recebe foco; motivo 'Faltam 2 páginas a conferir.' visível e ligado por aria-describedby",
      !b.desabilitado &&
        b.ariaDisabled === "true" &&
        b.tabindex >= 0 &&
        b.focado &&
        b.motivo === "Faltam 2 páginas a conferir." &&
        b.motivoVisivel,
      JSON.stringify(b),
    );
    await verificar.press("Enter");
    const focoNaPrimeira = await page.evaluate(
      () => document.activeElement?.getAttribute("data-slot") === "conferir-botao",
    );
    registrar(
      "b: acionar com Enter leva o foco ao primeiro 'Conferi no livro'",
      focoNaPrimeira,
      `${focoNaPrimeira}`,
    );

    // (d) linha de conferência
    const linhasDeConferencia = await page
      .locator('[data-slot="conferencia-item"][data-estado="a-conferir"]')
      .evaluateAll((els) =>
        els.map((el) => {
          const botao = el.querySelector('[data-slot="conferir-botao"]') as HTMLElement;
          const r = botao.getBoundingClientRect();
          const pagina = (el.querySelector('span[aria-hidden="true"]')?.textContent ?? "").trim();
          const falado = (botao.textContent ?? "").replace(/\s+/g, " ").trim();
          const copia = botao.cloneNode(true) as HTMLElement;
          for (const oculto of copia.querySelectorAll(".sr-only")) oculto.remove();
          const visivel = (copia.textContent ?? "").replace(/\s+/g, " ").trim();
          // O rótulo visível não pode ter buraco no meio (o botão é `flex` com `gap`): compara a largura do rótulo
          // com a de um `span` de controle com o mesmo texto e a mesma fonte.
          const rotulo = botao.firstElementChild as HTMLElement;
          const controle = document.createElement("span");
          controle.textContent = "Conferi no livro";
          controle.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
          botao.append(controle);
          const diferenca = Math.abs(
            rotulo.getBoundingClientRect().width - controle.getBoundingClientRect().width,
          );
          controle.remove();
          return {
            pagina,
            h: Math.round(r.height),
            w: Math.round(r.width),
            falado,
            visivel,
            diferenca: Math.round(diferenca * 10) / 10,
            edicao: (el.textContent ?? "").includes("conferir na edição:"),
          };
        }),
      );
    registrar(
      "d: 2 linhas a conferir com 'p. …', 'conferir na edição:', botão ≥ 44×44, nome acessível 'Conferi a página … no livro', rótulo visível 'Conferi no livro' e sem buraco no meio (< 2 px de diferença para um rótulo de controle)",
      linhasDeConferencia.length === 2 &&
        linhasDeConferencia.every(
          (l) =>
            l.pagina.startsWith("p. ") &&
            l.edicao &&
            l.h >= 44 &&
            l.w >= 44 &&
            /^Conferi a página .+ no livro$/.test(l.falado) &&
            l.visivel === "Conferi no livro" &&
            l.diferenca < 2,
        ),
      linhasDeConferencia
        .map((l) => `${l.pagina} ${l.w}x${l.h} "${l.falado}" / "${l.visivel}" (Δ ${l.diferenca}px)`)
        .join("; "),
    );

    // (e) ficha inteira legível
    const leitura = await page.evaluate(() => {
      const tese = document.querySelector('[aria-labelledby="ficha-tese"] p') as HTMLElement;
      const arg = document.querySelector('[data-slot="item-de-ficha"] p') as HTMLElement;
      const no = arg.firstChild as Text;
      const faixa = document.createRange();
      let primeiraLinha = no.length;
      let topo: number | null = null;
      for (let i = 1; i <= no.length; i++) {
        faixa.setStart(no, 0);
        faixa.setEnd(no, i);
        const rects = faixa.getClientRects();
        const base = Math.round(rects[rects.length - 1]?.top ?? 0);
        if (topo === null) topo = base;
        else if (Math.abs(base - topo) > 4) {
          primeiraLinha = i - 1;
          break;
        }
      }
      return {
        tamanho: Number.parseFloat(getComputedStyle(tese).fontSize),
        primeiraLinha,
        textoDoArgumento: no.length,
        h2: Array.from(document.querySelectorAll("article h2")).map((h) => h.textContent ?? ""),
      };
    });
    const largura = page.viewportSize()?.width ?? 0;
    registrar(
      "e: Tese com fonte ≥ 19 px; primeira linha do argumento 25–75 caracteres (ou o argumento inteiro cabe); quatro h2 na ordem fixa",
      leitura.tamanho >= 19 &&
        (leitura.primeiraLinha >= 25 || leitura.primeiraLinha === leitura.textoDoArgumento) &&
        leitura.primeiraLinha <= 75 &&
        JSON.stringify(leitura.h2.slice(0, 4)) ===
          JSON.stringify([
            "Tese",
            "Argumentos",
            "Trechos citados",
            "O que esta obra não pode dizer",
          ]),
      `${leitura.tamanho}px; ${leitura.primeiraLinha} car. na 1.ª linha (${largura}px de janela); ${leitura.h2.join(" > ")}`,
    );

    // (f) progresso em texto no cabeçalho
    const prog = await page.evaluate(() => {
      const barra = document.querySelector(
        'article [data-slot="progresso-da-ficha"] [role="progressbar"]',
      ) as HTMLElement;
      const texto = document.querySelector('article [data-slot="progresso-da-ficha"] p');
      return {
        texto: texto?.textContent ?? "",
        agora: barra.getAttribute("aria-valuenow"),
        max: barra.getAttribute("aria-valuemax"),
        valuetext: barra.getAttribute("aria-valuetext"),
        altura: Math.round(barra.getBoundingClientRect().height),
      };
    });
    registrar(
      "f: detalhe com '2 de 4 páginas conferidas', progressbar 2/4 com aria-valuetext igual e barra de 4 px",
      prog.texto === "2 de 4 páginas conferidas" &&
        prog.agora === "2" &&
        prog.max === "4" &&
        prog.valuetext === prog.texto &&
        prog.altura === 4,
      JSON.stringify(prog),
    );
    registrar(
      "g: detalhe sem rolagem horizontal e sem bloco cortado",
      (await sobraHorizontal(page)) <= 0 && (await cortados(page)) === 0,
      `sobra ${await sobraHorizontal(page)}px, ${await cortados(page)} cortados`,
    );
    await foto("detalhe");
    await cinza("detalhe");

    // (h) primeiro clique em "Conferi no livro"
    const antes = await page
      .locator('[data-slot="conferencia-item"][data-estado="conferida"]')
      .count();
    const primeiro = page.locator('[data-slot="conferir-botao"]').first();
    await primeiro.click();
    await expect
      .poll(() => page.locator('[data-slot="conferencia-item"][data-estado="conferida"]').count())
      .toBe(antes + 1);
    registrar(
      "h: um clique em 'Conferi no livro' troca o chip para 'Conferida em' e o progresso para '3 de 4'",
      (await page.getByText("3 de 4 páginas conferidas").count()) > 0 &&
        (await page.getByText(/^Conferida em /).count()) === antes + 1,
      `conferidas: ${antes} -> ${antes + 1}`,
    );

    // ── Diálogo (ficha pronta) ──
    await page.goto(`/admin/acervo/fichas/${fichas.umapagina}`);
    const verificar2 = page.getByRole("button", { name: "Marcar como verificada", exact: true });
    await esperarHidratado(verificar2);
    await verificar2.click();
    const dialogo = page.getByRole("alertdialog");
    await expect(dialogo).toBeVisible();
    const c1 = await page.evaluate(() => {
      const ativo = document.activeElement as HTMLElement | null;
      const d = document.querySelector('[role="alertdialog"]') as HTMLElement;
      const r = d.getBoundingClientRect();
      return {
        foco: ativo?.textContent?.trim() ?? "",
        titulo: d.querySelector("h2")?.textContent ?? "",
        corpo: d.textContent ?? "",
        dentro:
          r.top >= 0 &&
          r.left >= 0 &&
          r.right <= window.innerWidth &&
          r.bottom <= window.innerHeight,
      };
    });
    registrar(
      "c: diálogo com foco inicial em 'Cancelar', título e corpo do contrato, dentro da janela",
      c1.foco === "Cancelar" &&
        c1.titulo === "Marcar como verificada?" &&
        c1.corpo.includes("O seu nome fica só no registro interno do painel.") &&
        c1.dentro,
      JSON.stringify({ foco: c1.foco, titulo: c1.titulo, dentro: c1.dentro }),
    );
    registrar(
      "g: diálogo aberto sem rolagem horizontal",
      (await sobraHorizontal(page)) <= 0,
      `sobra ${await sobraHorizontal(page)}px`,
    );
    // O diálogo entra com um fade de 200 ms: a captura espera o fim, senão sai translúcida.
    await page.waitForTimeout(450);
    await foto("dialogo", false);
    await cinza("dialogo");
    await page.keyboard.press("Escape");
    await expect(dialogo).toHaveCount(0);
    const c2 = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    registrar(
      "c: depois de Esc o diálogo saiu e o foco voltou a 'Marcar como verificada'",
      c2 === "Marcar como verificada",
      c2,
    );

    // ── Segundo fator vencido (i) ──
    await escrever(
      'delete from admin.sessao_mfa where session_id in (select s.id from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1)',
      [admin.endereco.toLowerCase()],
    );
    await verificar2.click();
    await dialogo.getByRole("button", { name: "Marcar como verificada" }).click();
    const erro = page
      .getByRole("alert")
      .filter({ hasText: "Sua verificação em duas etapas venceu." });
    await expect(erro).toBeVisible();
    const i = await page.evaluate(() => {
      const alerta = Array.from(document.querySelectorAll('[role="alert"]')).find((e) =>
        (e.textContent ?? "").includes("duas etapas"),
      ) as HTMLElement;
      const link = alerta.querySelector("a") as HTMLElement;
      const r = link.getBoundingClientRect();
      const a = alerta.getBoundingClientRect();
      return {
        texto: (alerta.textContent ?? "").replace(/\s+/g, " ").trim(),
        link: (link.textContent ?? "").trim(),
        alvo: Math.round(r.height),
        dentro: a.left >= 0 && a.right <= window.innerWidth,
        filete: getComputedStyle(alerta).borderLeftColor,
        papel: getComputedStyle(document.body).backgroundColor,
      };
    });
    registrar(
      "i: erro com a frase do contrato, link 'Confirmar o segundo fator' ≥ 44 px, dentro da janela, filete ≥ 3:1 em cinza",
      i.texto.includes("Erro.") &&
        i.texto.includes(
          "Sua verificação em duas etapas venceu. Confirme de novo para marcar a ficha.",
        ) &&
        i.link === "Confirmar o segundo fator" &&
        i.alvo >= 44 &&
        i.dentro &&
        contrasteEmCinza(lerRgb(i.filete), lerRgb(i.papel)) >= 3,
      `${i.link} ${i.alvo}px; filete ${contrasteEmCinza(lerRgb(i.filete), lerRgb(i.papel)).toFixed(2)}:1`,
    );
    await foto("segundo-fator");

    writeFileSync(
      path.join(PASTA as string, `18-painel-fichas-${nome}.json`),
      JSON.stringify(resultado, null, 2),
    );
    const reprovadas = resultado.filter((l) => !l.ok);
    expect(reprovadas, JSON.stringify(reprovadas, null, 2)).toEqual([]);
  });
}
