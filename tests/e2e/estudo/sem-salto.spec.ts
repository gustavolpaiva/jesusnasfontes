import { expect, type Page, test } from "@playwright/test";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
import { instalarFalaFalsa, liberarVozes, VOZ_PT_BR } from "../../support/fala-falsa";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// O Estudo não pode mudar de lugar sozinho depois de aberto (plano 02-ajustes, defeitos 1 e 2). Dois
// motivos mediam deslocamento (diagnóstico em .planning/phases/02-acervo/medicoes/e2e-instavel.md):
//   1. a linha "Procurando voz em português…" do controle Ouvir, que aparecia e sumia (2 x 30,5 px);
//   2. a troca do esqueleto "Carregando o texto…" pelo texto bíblico (streaming), que descia ~1137 px o
//      que vem depois da Leitura.
// Mede-se em 390 px de largura, com um rastreador de posição (requestAnimationFrame, vale nos dois
// motores) e, no Chromium, com o `layout-shift` do PerformanceObserver (o CLS que o navegador conta).

const ESTUDO = "/estudos/batismo-e-tentacao";

test.use({ viewport: { width: 390, height: 844 } });

type Amostra = { t: number; cabecalho: number | null; corpo: number | null; mensagem: string[] };
type Rastro = {
  amostras: Amostra[];
  deslocamentos: Deslocamento[];
  textoChegouEm: number | undefined;
};
type Deslocamento = {
  valor: number;
  t: number;
  recente: boolean;
  fontes: { no: string; de: string; para: string }[];
};

const RASTREADOR = `(() => {
  const amostras = [];
  const deslocamentos = [];
  window.__rastro = { amostras, deslocamentos, textoChegouEm: undefined };
  try {
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) {
        deslocamentos.push({
          valor: e.value,
          t: e.startTime,
          recente: e.hadRecentInput,
          fontes: e.sources.map((f) => ({
            no: f.node ? f.node.nodeName + "." + (f.node.className || "").toString().slice(0, 60) + "#" + (f.node.id || "") : "?",
            de: Math.round(f.previousRect.y) + "+" + Math.round(f.previousRect.height),
            para: Math.round(f.currentRect.y) + "+" + Math.round(f.currentRect.height),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  let ultimo = "";
  let viuEsqueleto = false;
  const olhar = (quadro) => {
    // Quadro em que o esqueleto da Leitura, visto antes, deixou de existir: o texto bíblico chegou. O
    // layout-shift desse quadro tem o mesmo startTime.
    const esqueleto = document.getElementById("leitura-carregando");
    if (esqueleto) viuEsqueleto = true;
    else if (viuEsqueleto && window.__rastro.textoChegouEm === undefined) window.__rastro.textoChegouEm = quadro;
    // O cabeçalho chega aos pedaços (streaming) e, antes de aparecer, fica num contêiner escondido (caixa
    // zerada): só vale depois que a última peça, a linha de estado do Ouvir, está nele e ele tem caixa.
    // Mede-se a ALTURA do cabeçalho e a distância do corpo ao topo do artigo, nunca a posição na janela:
    // a faixa da Sessão, que chega por conta própria acima de tudo, desloca a janela inteira.
    const artigo = document.querySelector("article");
    const cab = document.querySelector("article > header:has([data-ouvir-mensagem])");
    const corpo = document.getElementById("estudo");
    const ra = artigo ? artigo.getBoundingClientRect() : null;
    const rc = cab ? cab.getBoundingClientRect() : null;
    const rb = corpo ? corpo.getBoundingClientRect() : null;
    const visivel = ra && ra.height > 0;
    const mensagens = [...document.querySelectorAll("[data-ouvir-mensagem]")].map((m) => m.textContent || "");
    const a = {
      t: performance.now(),
      cabecalho: visivel && rc && rc.height > 0 ? Math.round(rc.height * 10) / 10 : null,
      corpo: visivel && rb && rb.height > 0 && ra ? Math.round((rb.top - ra.top) * 10) / 10 : null,
      mensagem: mensagens,
    };
    const chave = JSON.stringify([a.cabecalho, a.corpo, a.mensagem]);
    if (chave !== ultimo) { ultimo = chave; amostras.push(a); }
    requestAnimationFrame(olhar);
  };
  requestAnimationFrame(olhar);
})();`;

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("estudo-sem-salto");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

async function ler(page: Page): Promise<Rastro> {
  return page.evaluate(() => (window as unknown as { __rastro: Rastro }).__rastro);
}

const variacao = (valores: number[]) =>
  valores.length === 0 ? 0 : Math.max(...valores) - Math.min(...valores);

test("a linha de busca de voz não move o Estudo: aparece e some sem deslocar nada", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await instalarFalaFalsa(page, { vozes: [VOZ_PT_BR], chegamEmMs: "manual" });
  await entrar(page);
  // O rastreador entra DEPOIS do login (o Estudo é a página que se mede).
  await page.addInitScript({ content: RASTREADOR });
  await page.goto(ESTUDO);
  const estudo = page.locator('[data-ouvir="estudo"]');
  await esperarHidratado(estudo.locator("button").first());
  // Controle positivo: a linha existiu de fato, com o texto exigido por AUD-02.
  await expect(estudo.getByText("Procurando voz em português…")).toBeVisible();
  await liberarVozes(page);
  await expect(estudo.getByText("Procurando voz em português…")).toHaveCount(0);
  await esperarEstudoAssentado(page);

  const { amostras } = await ler(page);
  expect(amostras.some((a) => a.mensagem.some((m) => m.includes("Procurando voz")))).toBe(true);
  // A altura do cabeçalho (onde mora o primeiro Ouvir) é a mesma em toda a carga: a linha de voz não a muda.
  const cabecalho = amostras.flatMap((a) => (a.cabecalho === null ? [] : [a.cabecalho]));
  expect(cabecalho.length).toBeGreaterThan(0);
  expect(variacao(cabecalho)).toBeLessThanOrEqual(0.5);
});

// O texto bíblico chega por streaming (Suspense). O esqueleto reserva uma altura próxima à do texto, para
// que o que vem depois da Leitura não desça (nem suba) sob os olhos de quem lê. A medição é a soma dos
// `layout-shift` (CLS) DEPOIS que o texto chegou, só no Chromium (o WebKit não tem a API), com a voz já
// disponível para a linha de busca de voz não entrar na conta. Um Estudo de 21 versículos, um de 16 e um
// capítulo de 48. O CLS total da carga também é relatado (inclui a faixa da Sessão, que chega por conta
// própria, e não entra na asserção: é outro defeito, não o do texto bíblico).
const ESTUDOS_DA_LEITURA = ["humildade-e-perdao", "batismo-e-tentacao", "mateus-5"];
const TETO_DE_CLS_DO_TEXTO = 0.005;

for (const slug of ESTUDOS_DA_LEITURA) {
  test(`o texto bíblico chega sem deslocar o que está à vista: ${slug}`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "layout-shift só existe no Chromium");
    test.setTimeout(120_000);
    await usarVozImediata(page);
    await entrar(page);
    await page.addInitScript({ content: RASTREADOR });
    await page.goto(`/estudos/${slug}`);
    await esperarEstudoAssentado(page);
    await page.waitForTimeout(500);
    const { amostras, deslocamentos, textoChegouEm } = await ler(page);
    const soma = (lista: Deslocamento[]) =>
      lista.filter((d) => !d.recente).reduce((s, d) => s + d.valor, 0);
    const corpo = amostras.flatMap((a) => (a.corpo === null ? [] : [a.corpo]));
    // Controle positivo: o esqueleto da Leitura existiu e saiu (senão não há troca a medir), e o corpo
    // do Estudo teve posição medida.
    expect(textoChegouEm, "o esqueleto da Leitura não chegou a aparecer").toBeDefined();
    expect(corpo.length).toBeGreaterThan(0);
    const depoisDoTexto = deslocamentos.filter((d) => d.t >= (textoChegouEm ?? 0) - 1);
    const clsDoTexto = soma(depoisDoTexto);
    console.log(
      `MEDICAO ${slug} cls_total=${soma(deslocamentos).toFixed(4)} cls_do_texto=${clsDoTexto.toFixed(4)} corpo_a_partir_do_artigo=${JSON.stringify(corpo)} fontes_do_texto=${JSON.stringify(depoisDoTexto.map((d) => d.fontes))}`,
    );
    expect(clsDoTexto).toBeLessThanOrEqual(TETO_DE_CLS_DO_TEXTO);
  });
}
