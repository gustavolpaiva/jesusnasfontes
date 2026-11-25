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
// 100: a página de créditos tem 77 paradas com os "Usado em" do Acervo (plano 02-22); com 70 ela não era
// percorrida até o fim.
const MAXIMO_DE_TABS = 100;

type Peco = { topo: number; esquerda: number };

type Passo = {
  nome: string;
  chave: string;
  topo: number;
  esquerda: number;
  // Os pedaços de linha do elemento, na ordem (vazio para o indicador do Next e para o corpo).
  pecos: Peco[];
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
        pecos: [],
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
        pecos: [],
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
      pecos: [...el.getClientRects()]
        .filter((p) => p.width > 0 && p.height > 0)
        .map((p) => ({ topo: p.top + window.scrollY, esquerda: p.left + window.scrollX })),
      fixo,
      contorno: Number.parseFloat(c.outlineWidth) || 0,
      estiloDoContorno: c.outlineStyle,
      dentroDoDialogo: !!el.closest('[role="dialog"], [role="alertdialog"]'),
      corpo: false,
    };
  });
}

// Um elemento em linha que quebra de linha tem mais de um pedaço, e o retângulo que os junta começa na linha de
// baixo: ele diria que o elemento está "à esquerda" do que veio antes, quando na verdade começa logo depois dele, no
// fim da linha (plano 02-22: o "Usado em" dos créditos é frase corrida, como o UI-SPEC manda, e os links quebram).
// Por isso a parada anterior conta pelo seu ÚLTIMO pedaço (onde termina) e a seguinte pelo PRIMEIRO (onde começa).
// Para elemento de um pedaço só (botão, link em bloco, campo) é exatamente a mesma conta de antes.
const porPosicao = (a: Peco, b: Peco) => a.topo - b.topo || a.esquerda - b.esquerda;
const fimDe = (p: Passo): Peco =>
  [...p.pecos].sort(porPosicao).at(-1) ?? { topo: p.topo, esquerda: p.esquerda };
const inicioDe = (p: Passo): Peco =>
  [...p.pecos].sort(porPosicao)[0] ?? { topo: p.topo, esquerda: p.esquerda };

/** As violações da ordem visual entre paradas consecutivas do fluxo: uma mensagem por violação. */
function violacoesDeOrdem(fluxo: Passo[]): string[] {
  const violacoes: string[] = [];
  for (let i = 1; i < fluxo.length; i++) {
    const anterior = fluxo[i - 1] as Passo;
    const atual = fluxo[i] as Passo;
    const a = fimDe(anterior);
    const b = inicioDe(atual);
    if (b.topo < a.topo - 4) violacoes.push(`ordem: ${atual.nome} está acima de ${anterior.nome}`);
    else if (Math.abs(b.topo - a.topo) <= 8 && b.esquerda < a.esquerda - 4)
      violacoes.push(`ordem: ${atual.nome} está à esquerda de ${anterior.nome}`);
  }
  return violacoes;
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
      expect(violacoesDeOrdem(fluxo)).toEqual([]);
    }
    // Foco visível em todo elemento que o recebeu.
    for (const p of passos) {
      expect(p.estiloDoContorno, `sem contorno de foco em ${p.nome}`).not.toBe("none");
      expect(p.contorno, `contorno de foco abaixo de 2 px em ${p.nome}`).toBeGreaterThanOrEqual(2);
    }
  });
}

// Controle positivo do medidor de ordem visual (a regra mudou no plano 02-22, por causa do link em prosa que quebra
// de linha): dois links em ordem, o segundo começando no fim da linha do primeiro e quebrando, NÃO dão violação; o
// segundo link posto ACIMA do primeiro dá. Prova que o medidor continua acusando desordem de verdade.
test("teclado: controle positivo, a ordem visual aceita o link em prosa que quebra de linha e acusa o que está fora de ordem", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "o foco do Safari por clique não segue a regra de teclado");
  // Como na página de créditos: o primeiro link vem depois de texto, no meio da linha; o segundo começa logo
  // depois dele e quebra para a linha de baixo.
  await page.setContent(
    '<!doctype html><p style="width:236px;margin:8px;font:16px/20px sans-serif">Antes, <a id="a" href="#a">Papias</a>, <a id="b" href="#b">Primeira Apologia e Segunda Apologia</a></p>',
  );
  await page.keyboard.press("Tab");
  const a = await focoAtual(page);
  await page.keyboard.press("Tab");
  const b = await focoAtual(page);
  // A condição do controle: o primeiro link tem um pedaço só; o segundo começa na mesma linha e quebra.
  expect(a.chave).toBe("A#0");
  expect(b.chave).toBe("A#1");
  expect(a.pecos).toHaveLength(1);
  expect(b.pecos.length).toBeGreaterThan(1);
  expect(inicioDe(b).topo).toBe(fimDe(a).topo);
  // O retângulo que junta os pedaços do segundo link começa na linha de baixo: à esquerda do primeiro.
  expect(b.esquerda).toBeLessThan(a.esquerda);
  expect(violacoesDeOrdem([a, b])).toEqual([]);
  // Agora o segundo link fica ACIMA do primeiro (fora da ordem visual): o medidor acusa.
  await page.setContent(
    '<!doctype html><p style="margin:40px 8px;font:16px/20px sans-serif"><a id="a" href="#a">Primeiro no Tab</a> <a id="b" href="#b" style="position:absolute;top:0;left:8px">Segundo no Tab</a></p>',
  );
  await page.keyboard.press("Tab");
  const c = await focoAtual(page);
  await page.keyboard.press("Tab");
  const d = await focoAtual(page);
  expect(violacoesDeOrdem([c, d])).toEqual([`ordem: ${d.nome} está acima de ${c.nome}`]);
});

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
