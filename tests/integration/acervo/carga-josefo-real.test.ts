import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { interpretarFonteYaml } from "@/modules/acervo/schemas";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import {
  CAMINHO_LOCK,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "../../../scripts/acervo/derivados";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// O derivado REAL do Josefo (o que o build de produção carrega) e o YAML REAL da Fonte, do repositório, num banco
// descartável: 20 seções, todos os parágrafos, id pela numeração da obra e a segunda carga sem mudar nada.
// Cria Fontes, então não roda no Neon (lá a carga real é conferida por contagem, sem teste de integração).

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("carga do derivado real do Josefo", () => {
  it("carrega 20 seções e todos os parágrafos; 18.63 e 20.197 como na origem; segunda carga sem mudança", async () => {
    const lock = lerLock(CAMINHO_LOCK);
    verificarDerivados(PASTA_DERIVADOS, lock);
    const derivado = lerDerivado(PASTA_DERIVADOS, lock, "josefo-antiguidades");
    const fonte = interpretarFonteYaml(
      readFileSync(
        path.join(RAIZ, "content", "acervo", "fontes", "josefo-antiguidades.yaml"),
        "utf8",
      ),
      "josefo-antiguidades.yaml",
    );
    const totalParagrafos = derivado.secoes.reduce((n, s) => n + s.paragrafos.length, 0);

    const r = await carregarFontes([{ fonte, derivado }], { cliente: carga });
    expect(r.secoes.inseridos).toBe(20);
    expect(r.paragrafos.inseridos).toBe(totalParagrafos);
    expect(totalParagrafos).toBeGreaterThan(1400);

    const p = await dono.query<{ ref: string; ref_inicio: number; ref_fim: number; texto: string }>(
      `select p.ref, p.ref_inicio, p.ref_fim, p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'josefo-antiguidades' and p.ref in ('18.63', '20.197') order by p.ref`,
    );
    expect(p.rows.map((x) => x.ref)).toEqual(["18.63", "20.197"]);
    expect(p.rows[0]?.texto).toContain("wise man");
    expect([p.rows[0]?.ref_inicio, p.rows[0]?.ref_fim]).toEqual([63, 64]);
    expect(p.rows[1]?.texto).toContain("brother of Jesus");
    expect(p.rows[1]?.texto).not.toContain("It hence evidently appears");
    expect([p.rows[1]?.ref_inicio, p.rows[1]?.ref_fim]).toEqual([197, 203]);

    const de = await dono.query<{ n: string }>(
      `select count(*) n from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
         join acervo.fonte f on f.id = s.fonte_id where f.slug = 'josefo-antiguidades'`,
    );
    expect(Number(de.rows[0]?.n)).toBe(totalParagrafos);

    const segunda = await carregarFontes([{ fonte, derivado }], { cliente: carga });
    expect(segunda.inseridos).toBe(0);
    expect(segunda.atualizados).toBe(0);
    expect(segunda.removidos).toBe(0);
  }, 120_000);
});
