import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { urlDoPapel } from "../../../src/db/url";

// Fumaça contra uma pré-visualização implantada. Nenhum endereço usado aqui tem convite: nada é
// enviado por e-mail (o que um convidado dispararia fica para a entrada real do dono).
//
//   PREVIEW_URL=<url> pnpm exec playwright test --project=preview
//
// Roda com as variáveis de conexão do banco de desenvolvimento no ambiente do processo (NEON_HOST,
// NEON_DATABASE, JNF_APP_PASSWORD). O banco é lido (contagens, nunca valores) só para provar o limite
// por IP.

const endereco = () => `fumaca-${randomBytes(5).toString("hex")}@convite.example`;

const PEDIDOS = Number(process.env.JNF_PREVIEW_PEDIDOS ?? 20);
// O limite é de 5 pedidos por IP em 60 s (janela ancorada no primeiro): 12,5 s entre pedidos mantém a
// execução abaixo dele. O IP real é o que a plataforma enxerga; o teste não pode trocá-lo.
const ESPACO_MS = Number(process.env.JNF_PREVIEW_ESPACO_MS ?? 12_500);
const DESCARTADOS = 2;

const cabecalhosDeBypass = (): Record<string, string> =>
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        "x-vercel-set-bypass-cookie": "true",
      }
    : {};

async function pedir(page: Page, alvo: string): Promise<number> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(alvo);
  const [resposta] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/entrar")),
    page.getByRole("button", { name: "Enviar acesso" }).click(),
  ]);
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
  const t = resposta.request().timing();
  return t.responseEnd - t.requestStart;
}

function p95(valores: number[]): number {
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil(0.95 * o.length) - 1)] as number;
}

async function contagemDePedidosPorIp(): Promise<{ chaves: number; soma: number }> {
  const c = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: true }) });
  await c.connect();
  try {
    const r = await c.query(
      "select count(*)::int as chaves, coalesce(sum(contagem), 0)::int as soma from admin.tentativa where chave like 'pedido-ip:%'",
    );
    return { chaves: r.rows[0].chaves as number, soma: r.rows[0].soma as number };
  } finally {
    await c.end();
  }
}

test("o ambiente da pré-visualização é dev", async ({ request }) => {
  const r = await request.get("/api/ambiente");
  expect(r.status()).toBe(200);
  expect(await r.text()).toBe('{"ambiente":"dev"}');
});

test("/entrar responde 200 com o título e o cabeçalho de segurança", async ({ page }) => {
  const r = await page.goto("/entrar");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const csp = r?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
});

test("endereço não convidado recebe a etapa neutra", async ({ page }) => {
  await pedir(page, endereco());
  await expect(page.getByText("Se este e-mail foi convidado, enviamos o acesso.")).toBeVisible();
});

test("link inválido: o GET só mostra a tela; o toque em Entrar leva a 'não vale mais', sem erro 500", async ({
  page,
}) => {
  // O GET nunca consulta o banco (um leitor automático não gasta o link): a tela é a mesma para
  // qualquer token. Só o POST do botão consome, e com um token inválido a resposta é a tela única.
  const r = await page.goto("/entrar/confirmar?token=invalido");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Confirmar entrada" })).toBeVisible();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Este link não vale mais" }),
  ).toBeVisible();
  expect(page.url()).toContain("invalido=1");
});

// Fase 2 (Acervo): sem sessão, as telas do Acervo levam à entrada e a página de créditos traz a seção dos textos. Nada é lido do banco
// nem gravado: só o que qualquer pessoa sem convite vê.
for (const rota of ["/acervo", "/acervo/busca"]) {
  test(`${rota} sem sessão leva a /entrar`, async ({ page }) => {
    await page.goto(rota);
    await expect(page).toHaveURL(/\/entrar(\?|$)/);
  });
}

test("/creditos mostra a seção Textos do Acervo", async ({ page }) => {
  const r = await page.goto("/creditos");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 2, name: "Textos do Acervo" })).toBeVisible();
});

test("a rota crua da biblioteca que envia e-mail responde 404", async ({ request }) => {
  const r = await request.post("/api/auth/sign-in/magic-link", {
    data: { email: endereco() },
    headers: { origin: process.env.PREVIEW_URL ?? "" },
  });
  expect(r.status()).toBe(404);
});

test("x-forwarded-for forjado não muda a chave do limite: o contador cresce pela do IP real", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const usar = async (cabecalhos: Record<string, string>) => {
    const contexto = await browser.newContext({
      baseURL: process.env.PREVIEW_URL,
      extraHTTPHeaders: { ...cabecalhosDeBypass(), ...cabecalhos },
    });
    const pagina = await contexto.newPage();
    try {
      await pedir(pagina, endereco());
    } finally {
      await contexto.close();
    }
  };
  // O primeiro pedido cria (ou renova) a chave do IP real; a partir daí ela existe e serve de base.
  await usar({});
  const base = await contagemDePedidosPorIp();
  await usar({ "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 250)}` });
  const depois = await contagemDePedidosPorIp();
  console.log(
    `limite por IP: chaves ${base.chaves} -> ${depois.chaves}; soma ${base.soma} -> ${depois.soma}`,
  );
  expect(depois.chaves).toBe(base.chaves); // nenhuma chave nova: o valor forjado não vira chave
  expect(depois.soma).toBe(base.soma + 1); // o pedido contou na chave que já existia
});

test(`tempo do pedido de acesso (não convidado): p95 de ${PEDIDOS} pedidos`, async ({
  page,
}, info) => {
  test.setTimeout(180_000 + (PEDIDOS + DESCARTADOS) * (ESPACO_MS + 8_000));
  // Os testes de cima já gastaram pedidos da mesma janela de 60 s do limite por IP: espera a janela
  // vencer, senão os primeiros pedidos medidos cairiam no limite e a medida seria de outra coisa.
  await page.waitForTimeout(61_000);
  const medidos: number[] = [];
  for (let i = 0; i < PEDIDOS + DESCARTADOS; i++) {
    const ms = await pedir(page, endereco());
    if (i >= DESCARTADOS) medidos.push(ms);
    await page.waitForTimeout(ESPACO_MS);
  }
  const resultado = {
    pedidos: medidos.length,
    descartados_de_aquecimento: DESCARTADOS,
    espaco_ms: ESPACO_MS,
    p95_nao_convidado_ms: Math.round(p95(medidos)),
    mediana_nao_convidado_ms: Math.round(
      [...medidos].sort((a, b) => a - b)[Math.floor(medidos.length / 2)] as number,
    ),
    maximo_ms: Math.round(Math.max(...medidos)),
    projeto: info.project.name,
    medido_em: new Date().toISOString(),
    nota: "duração da resposta da ação do servidor, medida no navegador; só o braço NÃO convidado (o convidado enviaria e-mail real)",
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/sp2-entrada-preview.json", JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado));
  // Sem teto fixo aqui: o número é o resultado. Só exige que todos os pedidos tenham respondido.
  expect(medidos).toHaveLength(PEDIDOS);
});
