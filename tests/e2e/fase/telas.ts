import { existsSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { semearCitacoesDaVarredura } from "../../support/citacao-e2e";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
import { falharFala, instalarFalaFalsa, VOZ_PT_BR } from "../../support/fala-falsa";
import {
  semearFichas,
  semearFichasParaConferir,
  type slugsParaConferir,
} from "../../support/ficha-e2e";
import { cargarFonteDoArquivo } from "../../support/fonte-painel-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import {
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  isolarIp,
  lerTexto,
  semearAdminParaTeste,
} from "../../support/login-e2e";
import { conferirParaTeste } from "../../support/verificar-ficha-teste";

// Lista única das telas e estados da fase (plano 01-19, Tarefa 2), usada pelos quatro testes de
// varredura: axe, reflow, teclado e escala de cinza. Roda sobre o conteúdo REAL (`content/`) e o banco da
// execução. Cada tela diz QUEM entra (e como) e COMO chegar ao estado; os testes só medem.

export type Quem =
  | "anonimo"
  | "estudante"
  | "estudante-sem-aceite"
  | "admin"
  | "admin-sem-segundo-fator";

export type Tela = {
  id: string;
  quem: Quem;
  abrir: (page: Page) => Promise<void>;
  /** Tela cuja leitura em escala de cinza é conferida (mensagem de status, grade, convites). */
  cinza?: boolean;
};

// A ficha de teste da varredura: semeada UMA vez por processo, no banco descartável da execução (o e2e inteiro roda
// num banco que é removido no fim, então não há o que limpar). Obra inventada, verificada pelas funções reais.
let fichaDaVarredura: Promise<string> | undefined;
function fichaVerificadaDaVarredura(): Promise<string> {
  fichaDaVarredura ??= semearFichas(`varredura-${process.pid}`).then((s) => s.slugs.completa);
  return fichaDaVarredura;
}

// As fichas do painel de fichas do Admin (plano 02-18), UMA vez por processo, nos cinco estados: a verificada e a alterada
// vêm de `semearFichas`; as outras entram como rascunho e são conferidas pelas funções reais do banco (nunca por evidência
// inserida direto): "conferir" fica em conferência (2 de 4), "umapagina" fica pronta, "confirmar" segue rascunho.
let fichasDoPainel: Promise<ReturnType<typeof slugsParaConferir>> | undefined;
function fichasDoPainelDaVarredura() {
  fichasDoPainel ??= (async () => {
    const sufixo = `varredura-${process.pid}`;
    await fichaVerificadaDaVarredura();
    const slugs = await semearFichasParaConferir(sufixo);
    await conferirParaTeste(process.env, slugs.conferir, 2);
    await conferirParaTeste(process.env, slugs.umapagina);
    return slugs;
  })();
  return fichasDoPainel;
}

// A carta de neutralidade só tem tela quando o dono a publica (D-08): sem o arquivo a rota é 404 e a tela não entra na
// varredura. `CARTA_DIR_PARA_TESTE` aponta para a fixture na conferência com carta (ignorada em produção).
const HA_CARTA = Boolean(
  process.env.CARTA_DIR_PARA_TESTE ||
    existsSync(path.join(process.cwd(), "content", "acervo", "carta-de-neutralidade.md")),
);

// A Fonte do arquivo com conflito da varredura (plano 02-17): carregada, editada no painel (limites) e carregada de novo,
// UMA vez por processo, no banco descartável da execução. Não publicada: nenhuma tela do Estudante a enxerga.
let conflitoDaVarredura: Promise<string> | undefined;
function fonteEmConflitoDaVarredura(): Promise<string> {
  conflitoDaVarredura ??= (async () => {
    const slug = `varredura-conflito-${process.pid}`;
    await cargarFonteDoArquivo(slug);
    await escrever("update acervo.fonte set limites_pt = $2 where slug = $1", [
      slug,
      "Limites editados no painel.",
    ]);
    await cargarFonteDoArquivo(slug);
    return slug;
  })();
  return conflitoDaVarredura;
}

// O Estudo com Citações aprovadas (plano 02-19), UMA vez por banco: Passagem, parágrafo de Fonte, ficha e as três juntas.
// A aprovação nasce pela função real do banco; a ficha é a verificada da varredura. Trava entre processos no ajudante.
let citacaoDaVarredura: Promise<string> | undefined;
function estudoComCitacaoDaVarredura(): Promise<string> {
  citacaoDaVarredura ??= fichaVerificadaDaVarredura().then((ficha) =>
    semearCitacoesDaVarredura(ficha),
  );
  return citacaoDaVarredura;
}

/** Abre todos os painéis de Citação do Estudo (um clique em cada botão, depois de hidratado). */
export async function abrirPaineisDeCitacao(page: Page): Promise<number> {
  const botoes = page.locator('[data-slot="citacao-botao"]');
  const n = await botoes.count();
  for (let i = 0; i < n; i++) {
    const botao = botoes.nth(i);
    await esperarHidratado(botao);
    await botao.click();
    await expect(botao).toHaveAttribute("aria-expanded", "true");
  }
  await expect(page.locator('[data-slot="citacao-painel"]')).toHaveCount(n);
  return n;
}

const ESTUDO_COM_PASSAGEM = "batismo-e-tentacao";
const ESTUDO_COM_DIVERGENCIA = "nicodemos-nascer-de-novo";

export async function entrarComo(page: Page, quem: Quem): Promise<void> {
  if (quem === "anonimo") return;
  // Voz pt-BR já disponível: a busca de voz do controle "Ouvir" termina na hora e a linha "Procurando
  // voz…" não empurra a página no meio do teste (ver `estudo-assentado.ts`). As telas de `ouvir`
  // reinstalam o próprio motor depois, e o último instalado vale.
  await usarVozImediata(page);
  if (quem === "estudante") {
    const email = emailDeTeste("fase");
    await convidarParaTeste(email);
    await entrarPorLink(page, email);
  } else if (quem === "estudante-sem-aceite") {
    const email = emailDeTeste("fase-sa");
    await convidarParaTeste(email, { semConsentimento: true });
    await entrarPorLink(page, email, "Antes de começar");
  } else if (quem === "admin") {
    await entrarComoAdmin(page, "fase-adm");
  } else {
    const email = emailDeTeste("fase-asf");
    await semearAdminParaTeste(email);
    await entrarPorLink(page, email, "Ative o segundo fator");
  }
}

// Entra como `tela.quem` e deixa a tela no estado pedido.
export async function prepararTela(page: Page, tela: Tela): Promise<void> {
  await entrarComo(page, tela.quem);
  await tela.abrir(page);
  // As animações de entrada (folhas, diálogos) terminam antes de medir: contraste lido no meio de um
  // desvanecer é medida falsa, não da tela.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function h1(page: Page, nome: string | RegExp): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: nome })).toBeVisible({
    timeout: 30_000,
  });
}

// Um Estudo sem nenhuma Passagem bíblica no conteúdo real (ensino sem texto).
async function slugSemPassagem(): Promise<string> {
  return lerTexto(
    `select e.slug as t from conteudo.estudo e
     where not exists (select 1 from conteudo.estudo_passagem p where p.estudo_id = e.id)
     order by e.slug limit 1`,
  );
}

// Um Estudo da Leitura contínua (capítulo de livro), cuja casa aparece na grade de capítulos das Trilhas.
export async function slugDeCapitulo(): Promise<string> {
  return lerTexto(
    "select slug as t from conteudo.estudo where capitulo is not null order by trilha_id, ordem limit 1",
  );
}

async function irParaEstudo(page: Page, slug: string): Promise<void> {
  await page.goto(`/estudos/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await esperarEstudoAssentado(page);
}

async function ouvirNo(page: Page, vozes: Parameters<typeof instalarFalaFalsa>[1]): Promise<void> {
  await instalarFalaFalsa(page, vozes);
  await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
  await esperarHidratado(page.locator('[data-ouvir="estudo"] button').first());
}

const principalOuvir = (page: Page) => page.locator('[data-ouvir="estudo"] button').first();
const faixa = (page: Page) => page.locator('[data-slot="sessao-bar"]');

async function fazerCheckIn(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: /Fazer check-in/ }).first();
  await esperarHidratado(botao);
  await botao.click();
  await expect(faixa(page)).toContainText(/Sessão aberta desde/, { timeout: 20_000 });
}

export const TELAS: Tela[] = [
  // Entrar
  {
    id: "entrar-1-email",
    quem: "anonimo",
    abrir: async (page) => {
      await page.goto("/entrar");
      await h1(page, "Entrar");
    },
  },
  {
    id: "entrar-2-verifique",
    quem: "anonimo",
    abrir: async (page) => {
      await isolarIp(page);
      await page.goto("/entrar");
      const campo = page.getByLabel("E-mail");
      await esperarHidratado(campo);
      await campo.fill(emailDeTeste("nao-convidado"));
      await page.getByRole("button", { name: "Enviar acesso" }).click();
      await h1(page, "Verifique seu e-mail");
    },
  },
  {
    id: "entrar-3-confirmar",
    quem: "anonimo",
    abrir: async (page) => {
      await page.goto("/entrar/confirmar?token=inexistente");
      await h1(page, "Confirmar entrada");
    },
  },
  {
    id: "entrar-link-invalido",
    quem: "anonimo",
    abrir: async (page) => {
      await page.goto("/entrar/confirmar?token=inexistente");
      await h1(page, "Confirmar entrada");
      const entrar = page.getByRole("button", { name: "Entrar", exact: true });
      await esperarHidratado(entrar);
      await entrar.click();
      await h1(page, "Este link não vale mais");
    },
  },
  {
    id: "entrar-erro-de-email",
    quem: "anonimo",
    cinza: true,
    abrir: async (page) => {
      await isolarIp(page);
      await page.goto("/entrar");
      const campo = page.getByLabel("E-mail");
      await esperarHidratado(campo);
      await campo.fill("sem-arroba");
      await page.getByRole("button", { name: "Enviar acesso" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Erro." })).toBeVisible();
    },
  },
  // Consentimento
  {
    id: "consentimento",
    quem: "estudante-sem-aceite",
    abrir: async (page) => {
      await h1(page, "Antes de começar");
    },
  },
  // Trilhas
  {
    id: "trilhas-sem-sessao",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      await expect(faixa(page)).toContainText("Nenhuma Sessão aberta.");
    },
  },
  {
    id: "trilhas-com-sessao",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      await fazerCheckIn(page);
    },
  },
  // Sessão (folha aberta)
  {
    id: "sessao-folha-aberta",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      await fazerCheckIn(page);
      const botao = page.getByRole("button", { name: "Fazer check-out" });
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("dialog", { name: "Encerrar a Sessão" })).toBeVisible();
    },
  },
  // Estudo
  {
    id: "estudo-com-citacao",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, await estudoComCitacaoDaVarredura());
      await expect(page.locator('[data-slot="citacao-botao"]').first()).toBeVisible();
    },
  },
  {
    id: "estudo-com-citacao-aberta",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await irParaEstudo(page, await estudoComCitacaoDaVarredura());
      expect(await abrirPaineisDeCitacao(page)).toBeGreaterThanOrEqual(4);
    },
  },
  {
    id: "estudo-com-passagem",
    quem: "estudante",
    abrir: (page) => irParaEstudo(page, ESTUDO_COM_PASSAGEM),
  },
  {
    id: "estudo-sem-passagem",
    quem: "estudante",
    abrir: async (page) => irParaEstudo(page, await slugSemPassagem()),
  },
  {
    id: "estudo-com-divergencia",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_DIVERGENCIA);
      await expect(page.getByRole("region", { name: "Divergência entre tradições" })).toBeVisible();
    },
  },
  {
    id: "estudo-concluido",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      const botao = page.getByRole("button", { name: "Marcar como concluído" });
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible({
        timeout: 20_000,
      });
    },
  },
  {
    id: "trilhas-leitura-continua-com-grade",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      const gatilho = page.getByRole("button", { name: /Leitura contínua/ });
      await esperarHidratado(gatilho);
      if ((await gatilho.getAttribute("aria-expanded")) !== "true") await gatilho.click();
      await expect(page.locator("a[data-estado]").first()).toBeVisible();
    },
  },
  // Ouvir (com o falso do motor de fala)
  {
    id: "ouvir-ocioso",
    quem: "estudante",
    abrir: (page) => ouvirNo(page, { vozes: [VOZ_PT_BR] }),
  },
  {
    id: "ouvir-lendo",
    quem: "estudante",
    abrir: async (page) => {
      await ouvirNo(page, { vozes: [VOZ_PT_BR] });
      await principalOuvir(page).click();
      await expect(principalOuvir(page)).toHaveText("Pausar");
    },
  },
  {
    id: "ouvir-pausado",
    quem: "estudante",
    abrir: async (page) => {
      await ouvirNo(page, { vozes: [VOZ_PT_BR] });
      await principalOuvir(page).click();
      await expect(principalOuvir(page)).toHaveText("Pausar");
      await principalOuvir(page).click();
      await expect(principalOuvir(page)).toHaveText("Continuar");
    },
  },
  {
    id: "ouvir-sem-voz",
    quem: "estudante",
    abrir: async (page) => {
      await ouvirNo(page, { vozes: [] });
      await expect(page.locator('[data-ouvir="estudo"]')).toContainText(
        "Seu aparelho não tem voz em português",
        { timeout: 8000 },
      );
    },
  },
  {
    id: "ouvir-falha",
    quem: "estudante",
    abrir: async (page) => {
      await ouvirNo(page, { vozes: [VOZ_PT_BR] });
      await principalOuvir(page).click();
      await expect(principalOuvir(page)).toHaveText("Pausar");
      await falharFala(page);
      await expect(
        page
          .locator('[data-ouvir="estudo"]')
          .getByRole("status")
          .filter({ hasText: "A leitura em voz parou." }),
      ).toBeVisible();
    },
  },
  // Anotação
  {
    id: "anotacao-vazia",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      await esperarHidratado(page.getByRole("textbox", { name: "Minha anotação" }));
    },
  },
  {
    id: "anotacao-salva",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      const campo = page.getByRole("textbox", { name: "Minha anotação" });
      await esperarHidratado(campo);
      await campo.fill("Anotação da varredura.");
      await expect(page.locator('[data-slot="save-status"]')).toHaveText("Salvo", {
        timeout: 20_000,
      });
    },
  },
  {
    id: "anotacao-sem-conexao",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      const campo = page.getByRole("textbox", { name: "Minha anotação" });
      await esperarHidratado(campo);
      await page.context().setOffline(true);
      await campo.fill("Escrita sem conexão.");
      await expect(page.locator('[data-slot="save-status"]')).toHaveText(
        "Sem conexão: rascunho guardado neste aparelho.",
      );
    },
  },
  // Acervo (plano 02-03)
  {
    id: "acervo-lista",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo");
      await h1(page, "Acervo");
      await expect(page.locator('[data-slot="linha-fonte"]').first()).toBeVisible();
    },
  },
  {
    id: "acervo-lista-filtrada",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo?nivel=primaria");
      await h1(page, "Acervo");
      await expect(
        page.getByRole("link", { name: /^Fonte primária/ }).filter({ visible: true }),
      ).toHaveAttribute("aria-current", "true");
    },
  },
  {
    id: "acervo-lista-aviso-de-nivel",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo?nivel=inexistente");
      await h1(page, "Acervo");
      await expect(
        page.getByRole("status").filter({ hasText: "Não há Fontes neste Nível ainda." }),
      ).toBeVisible();
    },
  },
  // Acervo: busca (plano 02-07)
  {
    id: "acervo-busca",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo/busca");
      await h1(page, "Buscar no Acervo");
      await expect(page.getByRole("radiogroup", { name: "Nível de fonte" })).toBeVisible();
    },
  },
  {
    id: "acervo-busca-populada",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo/busca");
      await h1(page, "Buscar no Acervo");
      const buscar = page.getByRole("button", { name: "Buscar", exact: true });
      await esperarHidratado(buscar);
      await page.getByRole("searchbox", { name: "Buscar no Acervo" }).fill("pilatos");
      await buscar.click();
      await expect(page.locator('[data-slot="resultado-busca"]').first()).toBeVisible();
    },
  },
  // Acervo: Fonte e seção (plano 02-06)
  {
    id: "acervo-fonte",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo/josefo-antiguidades");
      await h1(page, "Antiguidades Judaicas");
      await expect(page.locator('[data-slot="bloco-proveniencia"]')).toBeVisible();
      await expect(page.locator('[data-slot="linha-secao"]').first()).toBeVisible();
    },
  },
  {
    id: "acervo-secao",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/acervo/josefo-antiguidades/18#p-18.63");
      await h1(page, "Livro 18");
      await expect(page.locator("#p-18\\.63")).toBeVisible();
      await expect(page.locator('[data-slot="resumo-auxiliar"]')).toBeVisible();
    },
  },
  // Acervo: ficha verificada (plano 02-16)
  {
    id: "acervo-ficha",
    quem: "estudante",
    cinza: true,
    abrir: async (page) => {
      const slug = await fichaVerificadaDaVarredura();
      await page.goto(`/acervo/${slug}`);
      await h1(page, "Obra de Teste Completa");
      await expect(page.locator('[data-slot="verificacao"]')).toBeVisible();
      await expect(page.locator('[data-slot="item-de-ficha"]').first()).toBeVisible();
    },
  },
  // Acervo: carta de neutralidade (plano 02-16), só quando publicada
  ...(HA_CARTA
    ? [
        {
          id: "acervo-carta",
          quem: "estudante" as const,
          cinza: true,
          abrir: async (page: Page) => {
            await page.goto("/acervo/carta-de-neutralidade");
            await h1(page, "Carta de neutralidade");
            await expect(page.locator('[data-slot="versao-da-carta"]')).toBeVisible();
          },
        },
      ]
    : []),
  // Caderno
  {
    id: "caderno-vazio",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/caderno");
      await h1(page, "Caderno");
      await expect(page.getByText("Seu Caderno está vazio")).toBeVisible();
    },
  },
  {
    id: "caderno-com-resultado",
    quem: "estudante",
    abrir: async (page) => {
      await irParaEstudo(page, ESTUDO_COM_PASSAGEM);
      const campo = page.getByRole("textbox", { name: "Minha anotação" });
      await esperarHidratado(campo);
      await campo.fill("Pensei no perdão que Jesus oferece.");
      await expect(page.locator('[data-slot="save-status"]')).toHaveText("Salvo", {
        timeout: 20_000,
      });
      await page.goto("/caderno");
      await h1(page, "Caderno");
      const buscar = page.getByRole("button", { name: "Buscar", exact: true });
      await esperarHidratado(buscar);
      await page.getByRole("searchbox", { name: "Buscar nas Anotações" }).fill("perdao");
      await buscar.click();
      await expect(page.locator('[data-slot="entrada-caderno"]')).toHaveCount(1, {
        timeout: 20_000,
      });
    },
  },
  // Conta
  {
    id: "conta",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/conta");
      await h1(page, "Conta");
    },
  },
  {
    id: "conta-dialogo-apagar",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/conta");
      await h1(page, "Conta");
      const botao = page.getByRole("button", { name: "Apagar minha conta" }).first();
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  // Admin
  {
    id: "admin-convites",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      // Um convite em cada estado: Pendente (o criado agora), Aceito e Revogado (marcados no banco).
      await page.goto("/admin/convites");
      await h1(page, "Convites");
      for (const [prefixo, estado] of [
        ["varredura-p", "pendente"],
        ["varredura-a", "aceito"],
        ["varredura-r", "revogado"],
      ] as const) {
        const e = emailDeTeste(prefixo);
        await page.getByLabel("E-mail da pessoa").fill(e);
        await page.getByRole("button", { name: "Convidar" }).click();
        await expect(page.getByRole("listitem").filter({ hasText: e })).toBeVisible();
        if (estado !== "pendente") {
          await escrever(
            estado === "aceito"
              ? "update admin.convite set estado = 'aceito', aceito_em = now() where email_norm = $1"
              : "update admin.convite set estado = 'revogado', revogado_em = now() where email_norm = $1",
            [e.toLowerCase()],
          );
        }
      }
      await page.goto("/admin/convites");
      await h1(page, "Convites");
      await expect(page.getByText("Revogado", { exact: true }).first()).toBeVisible();
    },
  },
  // Admin: painel de Fontes (plano 02-17)
  {
    id: "admin-fontes-lista",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      await fonteEmConflitoDaVarredura();
      await page.goto("/admin/acervo/fontes");
      await h1(page, "Fontes");
      // Duas origens e o chip de atenção na mesma tela: a Fonte em conflito e a do arquivo sem conflito.
      await expect(page.getByText("Em conflito com a carga").first()).toBeVisible();
    },
  },
  {
    id: "admin-fonte-formulario",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      await page.goto("/admin/acervo/fontes/novo");
      await h1(page, "Incluir Fonte");
      await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));
      // O erro de ACER-09 no campo, com o foco movido: o estado mais exigente da tela.
      await page.getByLabel("Título", { exact: true }).fill("Obra para a varredura");
      await page
        .getByLabel("Origem do texto (endereço https)")
        .fill("https://exemplo.invalid/obra");
      await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
      await page.getByRole("checkbox", { name: "Obra protegida" }).click();
      await page.getByRole("button", { name: "Salvar Fonte" }).click();
      await expect(page.getByText(/Obra protegida não pode ter texto integral/)).toBeVisible();
    },
  },
  {
    id: "admin-fonte-conflito",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      const slug = await fonteEmConflitoDaVarredura();
      await page.goto(`/admin/acervo/fontes/${slug}`);
      await h1(page, `Fonte do arquivo ${slug}`);
      await expect(page.locator('[data-slot="aviso-de-conflito"]')).toBeVisible();
    },
  },
  // Admin: painel de fichas (plano 02-18)
  {
    id: "admin-fichas-fila",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      await fichasDoPainelDaVarredura();
      await page.goto("/admin/acervo/fichas");
      await h1(page, "Fichas a verificar");
      // Os cinco estados na mesma tela: é o que a leitura em cinza precisa distinguir.
      for (const estado of ["pronta", "em-conferencia", "rascunho", "alterada", "verificada"])
        await expect(
          page.locator(`[data-slot="linha-ficha-admin"][data-estado="${estado}"]`).first(),
        ).toBeVisible();
    },
  },
  {
    id: "admin-ficha-detalhe",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      const slugs = await fichasDoPainelDaVarredura();
      await page.goto(`/admin/acervo/fichas/${slugs.conferir}`);
      await h1(page, /Obra a conferir/);
      await esperarHidratado(
        page.getByRole("button", { name: "Marcar como verificada", exact: true }),
      );
      await expect(page.getByText("2 de 4 páginas conferidas")).toBeVisible();
    },
  },
  {
    id: "admin-ficha-dialogo",
    quem: "admin",
    cinza: true,
    abrir: async (page) => {
      const slugs = await fichasDoPainelDaVarredura();
      await page.goto(`/admin/acervo/fichas/${slugs.umapagina}`);
      const botao = page.getByRole("button", { name: "Marcar como verificada", exact: true });
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    id: "admin-segundo-fator",
    quem: "admin-sem-segundo-fator",
    abrir: async (page) => {
      await h1(page, "Ative o segundo fator");
    },
  },
  // Públicas e globais
  {
    id: "creditos",
    quem: "anonimo",
    abrir: async (page) => {
      await page.goto("/creditos");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    id: "menu-aberto",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      const botao = page.getByRole("button", { name: "Abrir menu" });
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    id: "menu-aberto-admin",
    quem: "admin",
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      const botao = page.getByRole("button", { name: "Abrir menu" });
      await esperarHidratado(botao);
      await botao.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Administração" })).toBeVisible();
    },
  },
  {
    id: "404",
    quem: "anonimo",
    abrir: async (page) => {
      await page.goto("/rota-que-nao-existe");
      await h1(page, "Página não encontrada");
    },
  },
  {
    id: "offline",
    quem: "estudante",
    abrir: async (page) => {
      await page.goto("/trilhas");
      await h1(page, "Trilhas");
      await esperarHidratado(page.getByRole("button", { name: "Abrir menu" }));
      await page.context().setOffline(true);
      await expect(page.getByRole("status").filter({ hasText: "Sem conexão." })).toBeVisible();
    },
  },
];
