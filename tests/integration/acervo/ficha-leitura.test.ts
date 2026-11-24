import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { lerFicha } from "@/modules/acervo/consultas-ficha";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// Leitura da ficha pelo Estudante (ACER-03, ACER-07, D-02, D-05): `lerFicha` passa pela porta `comAcervo` (papel do
// aplicativo, política de linha valendo). Rascunho, ficha inexistente e ficha alterada depois de verificada dão o
// MESMO `null`; a ficha verificada devolve o conteúdo e a data, e nenhum campo de pessoa. A ficha é a FICTÍCIA
// `obra-de-teste`. Cria dado, então usa um banco descartável SÓ deste arquivo e não roda no Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let envDoBanco: Record<string, string> = {};
let carga: pg.Client;
let dono: pg.Client;

const yamlDaFicha = readFileSync(
  path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas", "obra-de-teste.yaml"),
  "utf8",
);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  envDoBanco = preparado.env;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.env.DATABASE_URL_OWNER });
  await dono.connect();
  await carregarRascunhos([interpretarFichaYaml(yamlDaFicha, "obra-de-teste.yaml")], {
    cliente: carga,
  });
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("leitura da ficha pelo Estudante", () => {
  it("controle positivo: a ficha existe no banco como rascunho", async () => {
    const n = await dono.query<{ n: number }>(
      "select count(*)::int as n from acervo.ficha_item where ficha_id = (select id from acervo.fonte where slug = 'obra-de-teste')",
    );
    expect(n.rows[0]?.n).toBe(3);
  });

  it("ficha em rascunho e ficha inexistente dão o mesmo null", async () => {
    expect(await lerFicha("obra-de-teste")).toBeNull();
    expect(await lerFicha("obra-que-nao-existe")).toBeNull();
  });

  it("Fonte de texto integral não é lida como ficha", async () => {
    await carga.query(
      `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
       values ('integral-de-teste', 'Texto de teste', 'primaria', 'integral', 'en', 'dp-dedicado',
               'Origem de teste', 'https://exemplo.invalid/', true)`,
    );
    expect(await lerFicha("integral-de-teste")).toBeNull();
  });

  it("verificada: devolve a ficha, os itens ordenados com a página e a data de verificação", async () => {
    await verificarFichaParaTeste(envDoBanco, "obra-de-teste");
    const f = await lerFicha("obra-de-teste");
    expect(f).not.toBeNull();
    expect(f).toMatchObject({
      slug: "obra-de-teste",
      titulo: "Obra de Teste",
      autor: "Autora de Teste",
      ano: 2001,
      editora: "Editora de Teste",
      edicaoConsultada: "Primeira edição de teste, 2001",
      idiomaTrechos: "en",
    });
    expect(f?.tesePt).toContain("carregador de rascunhos");
    expect(f?.limitesPt).toBe("Obra inventada; nada nela é fato histórico.");
    expect(f?.verificadaEm).toBeInstanceOf(Date);
    expect(Math.abs((f?.verificadaEm.getTime() ?? 0) - Date.now())).toBeLessThan(5 * 60_000);
    expect(f?.argumentos.map((i) => i.pagina)).toEqual([
      { inicio: 10, fim: 10, texto: null },
      { inicio: 12, fim: 14, texto: null },
    ]);
    expect(f?.trechos).toHaveLength(1);
    expect(f?.trechos[0]).toMatchObject({
      pagina: { inicio: null, fim: null, texto: "xi-xii" },
      trechoOriginal: "This is an invented test sentence, not taken from any book.",
      idiomaTrecho: "en",
    });
  });

  it("não expõe campo de pessoa nem de evidência: nem na ficha nem nos itens (D-05)", async () => {
    const f = await lerFicha("obra-de-teste");
    expect(f).not.toBeNull();
    const chaves = JSON.stringify([
      Object.keys(f ?? {}),
      ...[...(f?.argumentos ?? []), ...(f?.trechos ?? [])].map((i) => Object.keys(i)),
    ]).toLowerCase();
    for (const proibida of ["por", "email", "usuario", "admin", "user", "hash", "confianca"]) {
      expect(chaves, proibida).not.toContain(`"${proibida}"`);
    }
    // O valor também: o e-mail da conta do Admin que verificou não aparece em nenhum lugar do que a consulta devolve.
    const emails = await dono.query<{ email: string }>(
      "select email from auth.\"user\" where role = 'admin'",
    );
    expect(emails.rows.length).toBeGreaterThan(0);
    const texto = JSON.stringify(f);
    for (const { email } of emails.rows) expect(texto).not.toContain(email);
  });

  it("alterada depois de verificada: volta a null; verificar de novo a traz de volta", async () => {
    await dono.query(
      "update acervo.ficha set tese_pt = tese_pt || ' Mudada.' where fonte_id = (select id from acervo.fonte where slug = 'obra-de-teste')",
    );
    expect(await lerFicha("obra-de-teste")).toBeNull();
    await verificarFichaParaTeste(envDoBanco, "obra-de-teste");
    const f = await lerFicha("obra-de-teste");
    expect(f?.tesePt).toContain("Mudada.");
  });

  it("item alterado depois de verificada: a ficha some", async () => {
    await dono.query(
      "update acervo.ficha_item set texto_pt = 'Argumento mudado.' where id = 'obra-de-teste/argumento-1'",
    );
    expect(await lerFicha("obra-de-teste")).toBeNull();
  });
});

describe.skipIf(emNeon())(
  "corrida: alteração confirmada no meio da leitura (revisão cruzada do 02-16)",
  () => {
    const ALTERADO = "Argumento mudado no meio da leitura.";

    it("a página nunca mostra ficha verificada com itens sumidos: a versão verificada inteira, ou nada", async () => {
      // Estado de partida: ficha verificada de novo, e a leitura comum a traz inteira (controle positivo).
      await verificarFichaParaTeste(envDoBanco, "obra-de-teste");
      const inteira = await lerFicha("obra-de-teste");
      expect(inteira?.argumentos).toHaveLength(2);
      expect(inteira?.trechos).toHaveLength(1);

      // Outra conexão confirma a mudança de um item DEPOIS de lida a verificação e ANTES da leitura dos itens.
      const lida = await lerFicha("obra-de-teste", {
        entreLeituras: async () => {
          await dono.query("update acervo.ficha_item set texto_pt = $1 where id = $2", [
            ALTERADO,
            "obra-de-teste/argumento-1",
          ]);
        },
      });
      // Controle de que a mudança foi confirmada: o banco já a tem.
      const noBanco = await dono.query<{ texto_pt: string }>(
        "select texto_pt from acervo.ficha_item where id = 'obra-de-teste/argumento-1'",
      );
      expect(noBanco.rows[0]?.texto_pt).toBe(ALTERADO);

      // Nunca a ficha verificada com seções faltando: ou inteira (a versão verificada, anterior à mudança) ou null.
      if (lida !== null) {
        expect(lida.argumentos).toHaveLength(2);
        expect(lida.trechos).toHaveLength(1);
        expect(lida.argumentos.map((a) => a.textoPt)).not.toContain(ALTERADO);
      }
      // Depois da mudança confirmada, a leitura seguinte já não vê a ficha (voltou a rascunho).
      expect(await lerFicha("obra-de-teste")).toBeNull();
    });
  },
);
