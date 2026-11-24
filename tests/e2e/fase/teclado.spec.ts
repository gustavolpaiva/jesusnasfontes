import { expect, type Page, test } from "@playwright/test";
import { prepararTela, TELAS } from "./telas";

// UI-04 (plano 01-19): o percurso só com teclado. Tab segue a ordem visual, não tem armadilha, o foco é
// sempre visível (contorno computado de pelo menos 2 px), o link de salto vem primeiro, e Esc fecha a
// folha e os diálogos devolvendo o foco ao botão que os abriu. Roda no Chromium (o Tab do Safari só
// percorre controles com uma opção do sistema; os demais testes de teclado do produto também o pulam).

const COM_DIALOGO = new Set([
  "sessao-folha-aberta",
  "menu-aberto",
  "menu-aberto-admin",
  "conta-dialogo-apagar",
  "admin-ficha-dialogo",
]);
const MAXIMO_DE_TABS = 70;

type Passo = {
  nome: string;
  chave: string;
  topo: number;
  esquerda: number;
  fixo: boolean;
  contorno: number;
  estiloDoContorno: string;
  dentroDoDialogo: boolean;
  corpo: boolean;
};

async function focoAtual(page: Page): Promise<Passo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    // O indicador do Next só existe no servidor de desenvolvimento; não é parte do produto.
    if (el?.tagName.toLowerCase() === "nextjs-portal") {
      return {
        nome: "nextjs-portal",
        chave: "nextjs-portal",
        topo: 0,
        esquerda: 0,
        fixo: true,
        contorno: 99,
        estiloDoContorno: "solid",
        dentroDoDialogo: false,
        corpo: false,
      };
    }
    if (!el || el === document.body) {
      return {
        nome: "body",
        chave: "body",
        topo: 0,
        esquerda: 0,
        fixo: false,
        contorno: 0,
        estiloDoContorno: "none",
        dentroDoDialogo: false,
        corpo: true,
      };
    }
    const r = el.getBoundingClientRect();
    // O campo do código de 6 dígitos é UM `input` com as casas desenhadas por cima: o contorno de foco
    // está na casa ativa, não no `input`.
    const ativa =
      el.tagName === "INPUT" && el.getAttribute("autocomplete") === "one-time-code"
        ? document.querySelector('[data-active="true"]')
        : null;
    const c = getComputedStyle(ativa ?? el);
    let fixo = false;
    for (let p: HTMLElement | null = el; p; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky") fixo = true;
    }
    const nome = (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    const indice = [...document.querySelectorAll(el.tagName)].indexOf(el);
    return {
      nome: `${el.tagName.toLowerCase()}: ${nome}`,
      chave: `${el.tagName}#${indice}`,
      topo: r.top + window.scrollY,
      esquerda: r.left + window.scrollX,
      fixo,
      contorno: Number.parseFloat(c.outlineWidth) || 0,
      estiloDoContorno: c.outlineStyle,
      dentroDoDialogo: !!el.closest('[role="dialog"], [role="alertdialog"]'),
      corpo: false,
    };
  });
}

for (const tela of TELAS) {
  test(`teclado: ordem, foco visível e sem armadilha: ${tela.id}`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === "webkit",
      "o Tab do Safari só percorre controles com a opção do sistema ligada",
    );
    test.setTimeout(120_000);
    await prepararTela(page, tela);
    const dialogo = COM_DIALOGO.has(tela.id);
    if (!dialogo) {
      // Volta o ponto de partida do Tab ao topo do documento: o Chromium parte do último elemento que
      // teve foco ou clique, e o estado das telas foi montado por cliques. Um nó descartável no topo,
      // focado e removido, é o ponto de partida.
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        const marca = document.createElement("span");
        marca.tabIndex = -1;
        document.body.prepend(marca);
        marca.focus();
        marca.remove();
      });
    }
    const passos: Passo[] = [];
    for (let i = 0; i < MAXIMO_DE_TABS; i++) {
      await page.keyboard.press("Tab");
      const p = await focoAtual(page);
      if (p.corpo) break;
      if (p.chave === "nextjs-portal") continue;
      const anterior = passos.at(-1);
      // Sem armadilha: cada Tab leva a OUTRO elemento.
      expect(p.chave, `Tab ${i + 1} ficou no mesmo elemento (${p.nome})`).not.toBe(anterior?.chave);
      // Volta ao primeiro: o ciclo fechou sem prender.
      if (passos.length > 2 && p.chave === passos[0]?.chave) break;
      passos.push(p);
    }
    expect(passos.length, "o Tab percorreu algum elemento").toBeGreaterThan(0);

    if (dialogo) {
      // Armadilha do bem: com o diálogo aberto o foco não escapa dele.
      for (const p of passos)
        expect(p.dentroDoDialogo, `foco fora do diálogo em ${p.nome}`).toBe(true);
    } else {
      // O link de salto vem primeiro.
      expect(passos[0]?.nome).toContain("Pular para o conteúdo");
      // Ordem visual: de cima para baixo e, na mesma linha, da esquerda para a direita. O que é fixo ou
      // grudado (cabeçalho, faixa da Sessão) muda de posição com a rolagem e fica fora da conta.
      const fluxo = passos.filter((p) => !p.fixo);
      for (let i = 1; i < fluxo.length; i++) {
        const a = fluxo[i - 1] as Passo;
        const b = fluxo[i] as Passo;
        expect(b.topo, `ordem: ${b.nome} está acima de ${a.nome}`).toBeGreaterThanOrEqual(
          a.topo - 4,
        );
        if (Math.abs(b.topo - a.topo) <= 8) {
          expect(
            b.esquerda,
            `ordem: ${b.nome} está à esquerda de ${a.nome}`,
          ).toBeGreaterThanOrEqual(a.esquerda - 4);
        }
      }
    }
    // Foco visível em todo elemento que o recebeu.
    for (const p of passos) {
      expect(p.estiloDoContorno, `sem contorno de foco em ${p.nome}`).not.toBe("none");
      expect(p.contorno, `contorno de foco abaixo de 2 px em ${p.nome}`).toBeGreaterThanOrEqual(2);
    }
  });
}

const FOLHAS = [
  { id: "menu-aberto", botao: "Abrir menu" },
  { id: "sessao-folha-aberta", botao: "Fazer check-out" },
  { id: "conta-dialogo-apagar", botao: "Apagar minha conta" },
] as const;

for (const folha of FOLHAS) {
  test(`teclado: Esc fecha ${folha.id} e o foco volta ao botão que abriu`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "webkit", "o foco do Safari por clique não segue a regra de teclado");
    test.setTimeout(120_000);
    const tela = TELAS.find((t) => t.id === folha.id);
    if (!tela) throw new Error(`tela ${folha.id} fora da lista`);
    await prepararTela(page, tela);
    const aberto = page.locator('[role="dialog"], [role="alertdialog"]');
    await expect(aberto).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(aberto).toHaveCount(0);
    await expect(page.getByRole("button", { name: folha.botao }).first()).toBeFocused();
  });
}
