import pg from "pg";
import { carregarRascunhos } from "../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../src/db/url";
import { interpretarFichaYaml } from "../../src/modules/acervo/schemas";
import { escrever } from "./login-e2e";
import { verificarFichaParaTeste } from "./verificar-ficha-teste";

// Fichas de TESTE para as telas da ficha (plano 02-16). A obra é INVENTADA: nada aqui é livro, autor ou frase real, e
// nenhuma das fichas reais (rascunhos do dono, D-17) passa por este arquivo. Entram SOB DEMANDA no banco do e2e, pelo
// carregador de rascunhos de verdade (`carregarRascunhos`), e a verificação é SEMPRE pelas funções do banco
// (`verificarFichaParaTeste`, plano 05): nunca se insere evidência direto. Saem no fim do arquivo de teste, pelo dono do
// banco. O sufixo do slug separa os dois projetos (celular e computador), que rodam o mesmo arquivo ao mesmo tempo no
// mesmo banco.

export const FICHAS = ["completa", "enxuta", "rascunho", "alterada"] as const;
export type FichaDeTeste = (typeof FICHAS)[number];
export type SlugsDeFicha = Record<FichaDeTeste, string>;

export const slugsDaFicha = (sufixo: string): SlugsDeFicha => ({
  completa: `ficha-teste-completa-${sufixo}`,
  enxuta: `ficha-teste-enxuta-${sufixo}`,
  rascunho: `ficha-teste-rascunho-${sufixo}`,
  alterada: `ficha-teste-alterada-${sufixo}`,
});

/** Trecho original de 275 caracteres: perto do teto de 300 do banco, para a tela medir a quebra. */
export const TRECHO_LONGO =
  "The invented committee of the invented town resolved, after a long and entirely fictional debate, that every ledger kept in the cellar of the old mill should be copied twice, bound in grey cloth, and shelved beside the window, so that no clerk could claim the sums were lost.";

export const LIMITES_DA_COMPLETA =
  "Obra inventada para teste: nada nela é fato histórico, e o método do autor fictício é descrito só para a tela ter o que mostrar.";

const BASE = {
  titulo: "Obra de Teste Completa",
  autor: "Autora de Teste",
  ano: 2001,
  editora: "Editora de Teste",
  edicao_consultada: "Primeira edição de teste, 2001",
  estado: "rascunho",
  origem_do_rascunho: "memoria-do-modelo",
  idioma_trechos: "en",
  tese_pt:
    "A obra de teste sustenta, só para fins de teste, que um livro-caixa copiado duas vezes não perde a soma.",
  serve_a: [],
} as const;

function fichaPronta(slug: string, qual: FichaDeTeste) {
  if (qual === "enxuta") {
    // Só argumentos: sem trecho e sem limites. As seções "Trechos citados" e "O que esta obra não pode dizer" não existem.
    return {
      ...BASE,
      slug,
      titulo: "Obra de Teste Enxuta",
      itens: [
        {
          tipo: "argumento",
          texto_pt: "Único argumento da obra enxuta.",
          pagina: "5",
          confianca: "alta",
        },
      ],
    };
  }
  return {
    ...BASE,
    slug,
    titulo: qual === "completa" ? "Obra de Teste Completa" : `Obra de Teste ${qual}`,
    limites_pt: LIMITES_DA_COMPLETA,
    itens: [
      {
        tipo: "argumento",
        texto_pt: "Primeiro argumento da obra de teste, em português, com uma frase só.",
        pagina: "39-53",
        confianca: "alta",
      },
      {
        tipo: "argumento",
        texto_pt: "Segundo argumento da obra de teste, numa página só.",
        pagina: "7",
        confianca: "media",
      },
      {
        tipo: "trecho",
        texto_pt: "Tradução do trecho curto de teste, em português.",
        trecho_original: "This is an invented test sentence, not taken from any book.",
        pagina: "xi-xii",
        confianca: "alta",
      },
      {
        tipo: "trecho",
        texto_pt: "Tradução do trecho longo de teste, em português.",
        trecho_original: TRECHO_LONGO,
        pagina: "101",
        confianca: "media",
      },
    ],
  };
}

/** Rótulo das datas e dos valores que o teste espera ler na tela. */
export const ESPERADO_DA_COMPLETA = {
  titulo: "Obra de Teste Completa",
  meta: "Autora de Teste, 2001, Editora de Teste",
  edicao: "Primeira edição de teste, 2001",
  paginas: ["p. 39–53", "p. 7", "p. xi–xii", "p. 101"],
};

export type FichasSemeadas = {
  slugs: SlugsDeFicha;
  /** Sessão do Admin de teste que verificou; o e-mail dele NÃO pode aparecer na tela. */
  emailDoAdmin: string;
};

export async function semearFichas(sufixo: string): Promise<FichasSemeadas> {
  const slugs = slugsDaFicha(sufixo);
  const fichas = FICHAS.map((qual) =>
    interpretarFichaYaml(JSON.stringify(fichaPronta(slugs[qual], qual)), `${qual}.yaml`),
  );
  const cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, process.env),
  });
  await cliente.connect();
  try {
    await carregarRascunhos(fichas, { cliente });
  } finally {
    await cliente.end().catch(() => {});
  }

  // Verifica pelas funções reais: completa, enxuta e alterada. O rascunho de controle nunca é verificado.
  let sessaoId = "";
  for (const qual of ["completa", "enxuta", "alterada"] as const) {
    const v = await verificarFichaParaTeste(process.env, slugs[qual]);
    sessaoId = v.sessaoId;
  }
  // A ficha "alterada" muda DEPOIS de verificada: o banco recalcula o hash e a verificação deixa de valer.
  await escrever(
    "update acervo.ficha set tese_pt = tese_pt || ' Alterada depois de verificada.' where fonte_id = (select id from acervo.fonte where slug = $1)",
    [slugs.alterada],
  );
  return { slugs, emailDoAdmin: await emailDaSessao(sessaoId) };
}

async function emailDaSessao(sessaoId: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    const r = await c.query<{ email: string }>(
      `select u.email from auth.session s join auth."user" u on u.id = s.user_id where s.id = $1`,
      [sessaoId],
    );
    return (r.rows[0] as { email: string }).email;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Tira as fichas de teste do banco do e2e, como dono (a carga recusa apagar Fonte inteira). */
export async function removerFichas(sufixo: string): Promise<void> {
  for (const slug of Object.values(slugsDaFicha(sufixo))) {
    // A cascata leva itens, conferência e verificação; o registro de verificação guarda só o slug como alvo.
    await escrever(
      "delete from acervo.ficha where fonte_id = (select id from acervo.fonte where slug = $1)",
      [slug],
    );
    await escrever("delete from acervo.fonte where slug = $1", [slug]);
  }
}
