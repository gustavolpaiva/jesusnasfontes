import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { ErroDeBanco } from "@/db/erro-banco";
import { urlDoPapel } from "@/db/url";
import { lerPassagem } from "@/modules/texto";
import {
  carregarEdicao,
  conjuntoDoRegistro,
  ErroCarga,
  lerEdicaoVerificada,
  type OpcoesEdicao,
} from "../../../scripts/ingest/carregar-biblia";
import { lerRegistro } from "../../../scripts/ingest/fontes";
import type { Versiculo } from "../../../scripts/ingest/parser-f4";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// A Bíblia Livre do arquivo ao banco e do banco à leitura. Cada afirmação negativa (a carga recusa,
// o papel não escreve) tem ao lado o controle positivo (a carga entra, o papel lê).

const SHA_DO_LOCK = "0".repeat(64);
const emNeon = () => inject("alvoBanco") === "neon";

async function comoPapel<T>(
  papel: "app" | "carga" | "assistente",
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

const codigoDe = (erro: unknown) => (erro as { code?: string }).code;

async function opcoesDa(
  lida: Awaited<ReturnType<typeof lerEdicaoVerificada>>,
): Promise<OpcoesEdicao> {
  const registro = await lerRegistro();
  return {
    edicao: lida.edicao,
    conjunto: conjuntoDoRegistro(registro, SHA_DO_LOCK),
    marcadores: lida.marcadores,
    mesclados: lida.mesclados,
  };
}

async function contar(sql: string, params: unknown[] = []): Promise<number> {
  const r = await obterPool().query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? -1;
}

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  await obterPool().end();
});

describe("tracer: João (n4) do arquivo ao banco e de volta", () => {
  it("carrega João, a segunda carga não muda nada e Jo 3:16 volta pela chave", async () => {
    const lida = await lerEdicaoVerificada("n4", { arquivos: ["joao.txt"] });
    expect(lida.versiculos).toHaveLength(879);
    const opcoes = await opcoesDa(lida);

    const primeira = await carregarEdicao(lida.versiculos, opcoes);
    expect(primeira.inseridos + primeira.alterados + primeira.inalterados).toBe(879);
    const segunda = await carregarEdicao(lida.versiculos, opcoes);
    expect(segunda).toEqual({ inseridos: 0, alterados: 0, inalterados: 879 });

    // Contagem do banco = contagem da entrada, por livro.
    expect(
      await contar(
        `select count(*)::int as n from acervo.texto_versiculo tv
         join acervo.versiculo v on v.id = tv.versiculo_id
         where tv.texto_id = 'blivre-n4' and v.livro = 43`,
      ),
    ).toBe(879);

    const passagem = await lerPassagem([{ inicio: 43003016, fim: 43003016 }], "blivre-n4");
    const verso = passagem.trechos[0]?.capitulos[0]?.versiculos[0];
    expect(passagem.trechos[0]?.capitulos).toHaveLength(1);
    expect(verso?.chave).toBe(43003016);
    expect(verso?.conteudo.startsWith("Porque Deus amou o mundo de tal maneira")).toBe(true);
    expect(verso?.conteudo).toBe(lida.versiculos.find((v) => v.chave === 43003016)?.texto);
  });

  it("cada versículo tem o marcador do arquivo-fonte ligado à chave", async () => {
    const r = await obterPool().query<{ versiculo_id: number }>(
      `select versiculo_id from acervo.correspondencia_versificacao
       where conjunto_id = 'biblia-livre' and ref_externa = 'Joao.3.16'`,
    );
    expect(r.rows[0]?.versiculo_id).toBe(43003016);
  });
});

describe("Passagem por intervalo de chave", () => {
  it("devolve exatamente os versículos do intervalo, em ordem, sem mais nem menos", async () => {
    const lida = await lerEdicaoVerificada("n4", { arquivos: ["joao.txt"] });
    await carregarEdicao(lida.versiculos, await opcoesDa(lida));
    // Jo 3:14-17: quatro versículos.
    const p = await lerPassagem([{ inicio: 43003014, fim: 43003017 }], "blivre-n4");
    const numeros = p.trechos[0]?.capitulos[0]?.versiculos.map((v) => v.numero);
    expect(numeros).toEqual([14, 15, 16, 17]);
    // Intervalo atravessando capítulo: Jo 3:35 a 4:2.
    const cruzado = await lerPassagem([{ inicio: 43003035, fim: 43004002 }], "blivre-n4");
    expect(
      cruzado.trechos[0]?.capitulos.map((c) => [c.capitulo, c.versiculos.map((v) => v.numero)]),
    ).toEqual([
      [3, [35, 36]],
      [4, [1, 2]],
    ]);
    // Dois intervalos: cada um lido por si, na ordem dada.
    const dois = await lerPassagem(
      [
        { inicio: 43003016, fim: 43003016 },
        { inicio: 43001001, fim: 43001002 },
      ],
      "blivre-n4",
    );
    expect(
      dois.trechos.map((t) => t.capitulos.flatMap((c) => c.versiculos.map((v) => v.chave))),
    ).toEqual([[43003016], [43001001, 43001002]]);
  });

  it("recusa intervalo invertido e chave que não é BBCCCVVV, sem tocar o banco", async () => {
    await expect(lerPassagem([{ inicio: 43003017, fim: 43003016 }])).rejects.toThrow(RangeError);
    await expect(lerPassagem([{ inicio: 43003000, fim: 43003016 }])).rejects.toThrow(RangeError);
    await expect(lerPassagem([{ inicio: 1, fim: 2 }])).rejects.toThrow(RangeError);
  });

  it("Marcos 5:18-19: o texto de 5:19 mora em 5:18 e a Passagem diz que está mesclado", async () => {
    const lida = await lerEdicaoVerificada("n4", { arquivos: ["mar.txt"] });
    await carregarEdicao(lida.versiculos, await opcoesDa(lida));
    expect(lida.mesclados).toEqual([
      { refExterna: "Mc.5.19", chave: 41005019, observacao: "texto dentro de Mc.5.18" },
    ]);

    // A chave 41005019 existe em versiculo e não tem linha de texto.
    expect(
      await contar("select count(*)::int as n from acervo.versiculo where id = 41005019"),
    ).toBe(1);
    expect(
      await contar(
        "select count(*)::int as n from acervo.texto_versiculo where versiculo_id = 41005019",
      ),
    ).toBe(0);

    const so18e19 = await lerPassagem([{ inicio: 41005018, fim: 41005019 }], "blivre-n4");
    const t = so18e19.trechos[0];
    expect(t?.capitulos[0]?.versiculos.map((v) => v.numero)).toEqual([18]);
    expect(t?.capitulos[0]?.versiculos[0]?.conteudo).toContain("não lhe permitiu");
    expect(t?.mesclados).toEqual([
      { chave: 41005019, refExterna: "Mc.5.19", observacao: "texto dentro de Mc.5.18" },
    ]);

    // Um intervalo que só encosta no mesclado pelo começo: 5:19 a 5:20.
    const de19 = await lerPassagem([{ inicio: 41005019, fim: 41005020 }], "blivre-n4");
    expect(de19.trechos[0]?.capitulos[0]?.versiculos.map((v) => v.numero)).toEqual([20]);
    expect(de19.trechos[0]?.mesclados.map((m) => m.chave)).toEqual([41005019]);

    // Controle: um intervalo que não passa por 5:19 não carrega mesclado algum.
    const sem = await lerPassagem([{ inicio: 41005020, fim: 41005022 }], "blivre-n4");
    expect(sem.trechos[0]?.mesclados).toEqual([]);

    // Atravessando o capítulo: 5:42 a 6:2 (5:43 é o último id do capítulo 5).
    const cruza = await lerPassagem([{ inicio: 41005042, fim: 41006002 }], "blivre-n4");
    expect(
      cruza.trechos[0]?.capitulos.map((c) => [c.capitulo, c.versiculos.map((v) => v.numero)]),
    ).toEqual([
      [5, [42, 43]],
      [6, [1, 2]],
    ]);
  });

  it("a edição exibida vem de conjunto_dados; sem escolha, n4", async () => {
    const lida = await lerEdicaoVerificada("n4", { arquivos: ["joao.txt"] });
    await carregarEdicao(lida.versiculos, await opcoesDa(lida));
    const p = await lerPassagem([{ inicio: 43003016, fim: 43003016 }]);
    expect(p.textoId).toBe("blivre-n4");
  });
});

describe("a carga recusa antes de escrever", () => {
  it("total diferente do esperado aborta e não deixa uma linha da edição", async () => {
    const lida = await lerEdicaoVerificada("tr", { arquivos: ["joao.txt"] });
    const antes = await contar(
      "select count(*)::int as n from acervo.texto_versiculo where texto_id = 'blivre-tr'",
    );
    await expect(
      carregarEdicao(lida.versiculos, { ...(await opcoesDa(lida)), totalEsperado: 878 }),
    ).rejects.toThrow(ErroCarga);
    expect(
      await contar(
        "select count(*)::int as n from acervo.texto_versiculo where texto_id = 'blivre-tr'",
      ),
    ).toBe(antes);
    // Controle positivo: com o total certo, a mesma entrada entra (parcial sem total, 879 linhas).
    const ok = await carregarEdicao(lida.versiculos, await opcoesDa(lida));
    expect(ok.inseridos + ok.alterados + ok.inalterados).toBe(879);
  });

  it("chave repetida, fora de ordem ou sem marcador aborta com ErroCarga", async () => {
    const lida = await lerEdicaoVerificada("n4", { arquivos: ["joao.txt"] });
    const opcoes = await opcoesDa(lida);
    const [a, b] = lida.versiculos as [Versiculo, Versiculo];
    await expect(carregarEdicao([a, a], opcoes)).rejects.toThrow(ErroCarga);
    await expect(carregarEdicao([b, a], opcoes)).rejects.toThrow(ErroCarga);
    await expect(carregarEdicao([a], { ...opcoes, marcadores: new Map() })).rejects.toThrow(
      ErroCarga,
    );
  });

  it.skipIf(emNeon())(
    "falha do banco no meio desfaz tudo e sai só com código, sem texto do banco",
    async () => {
      // Gn 1:1 com um byte nulo: o banco recusa só na linha de texto, depois de livro e versículo.
      const lida = await lerEdicaoVerificada("n4", { arquivos: ["gen.txt"] });
      const gn11 = lida.versiculos.find((v) => v.chave === 1001001) as Versiculo;
      const ruim: Versiculo = { ...gn11, texto: "antes\u0000depois" };
      const antesVersiculos = await contar("select count(*)::int as n from acervo.versiculo");
      const antesLinha = await contar(
        "select count(*)::int as n from acervo.texto_versiculo where texto_id = 'blivre-n4' and versiculo_id = 1001001",
      );
      const opcoes = await opcoesDa(lida);
      const erro = await carregarEdicao([ruim], opcoes).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroDeBanco);
      expect((erro as ErroDeBanco).code).toBe("22021");
      const impresso =
        JSON.stringify(erro) + String((erro as Error).message) + String((erro as Error).stack);
      expect(impresso).not.toContain("postgres://");
      expect(impresso).not.toContain(process.env.JNF_CARGA_PASSWORD ?? "sem-senha");
      expect(impresso).not.toContain("antes");
      expect(await contar("select count(*)::int as n from acervo.versiculo")).toBe(antesVersiculos);
      expect(
        await contar(
          "select count(*)::int as n from acervo.texto_versiculo where texto_id = 'blivre-n4' and versiculo_id = 1001001",
        ),
      ).toBe(antesLinha);
      // Controle positivo: o Gn 1:1 verdadeiro entra.
      const bom = await carregarEdicao([gn11], opcoes);
      expect(bom.inseridos + bom.alterados + bom.inalterados).toBe(1);
    },
  );
});

describe("papéis: quem escreve e quem lê", () => {
  it("jnf_app lê o texto e não escreve em nenhuma tabela do texto (42501)", async () => {
    await comoPapel("app", async (c) => {
      const leitura = await c.query("select count(*)::int as n from acervo.texto_versiculo");
      expect(leitura.rows[0].n).toBeGreaterThan(0);
      const escritas = [
        "insert into acervo.texto_versiculo (texto_id, versiculo_id, conteudo, conteudo_hash) values ('blivre-n4', 43003016, 'x', repeat('0', 64))",
        "update acervo.texto_versiculo set conteudo = 'x' where texto_id = 'blivre-n4'",
        "delete from acervo.texto_versiculo where texto_id = 'blivre-n4'",
        "update acervo.conjunto_dados set edicao_exibida = 'tr'",
        "delete from acervo.correspondencia_versificacao",
        "insert into acervo.fonte (nivel, titulo) values ('primaria', 'x')",
        "delete from conteudo.estudo",
      ];
      for (const comando of escritas) {
        const erro = await c.query(comando).catch((e: unknown) => e);
        expect(codigoDe(erro), comando).toBe("42501");
      }
    });
  });

  it("jnf_assistente lê o acervo e não escreve nele", async () => {
    await comoPapel("assistente", async (c) => {
      const leitura = await c.query("select count(*)::int as n from acervo.texto_versiculo");
      expect(leitura.rows[0].n).toBeGreaterThan(0);
      const erro = await c
        .query("delete from acervo.texto_versiculo where texto_id = 'blivre-n4'")
        .catch((e: unknown) => e);
      expect(codigoDe(erro)).toBe("42501");
    });
  });

  it("jnf_carga escreve no acervo e não lê privado nem auth (42501)", async () => {
    await comoPapel("carga", async (c) => {
      // Controle positivo: lê o que carrega.
      const leitura = await c.query("select count(*)::int as n from acervo.texto_versiculo");
      expect(leitura.rows[0].n).toBeGreaterThan(0);
      for (const consulta of [
        "select count(*) from privado.anotacao",
        'select count(*) from auth."user"',
      ]) {
        const erro = await c.query(consulta).catch((e: unknown) => e);
        expect(codigoDe(erro), consulta).toBe("42501");
      }
    });
  });

  it("o acervo carregado não está em privado", async () => {
    const r = await obterPool().query<{ n: number }>(
      `select count(*)::int as n from pg_class c
       where c.relnamespace = 'privado'::regnamespace and c.relname in
         ('texto_versiculo', 'versiculo', 'texto', 'conjunto_dados', 'correspondencia_versificacao')`,
    );
    expect(r.rows[0]?.n).toBe(0);
  });
});
