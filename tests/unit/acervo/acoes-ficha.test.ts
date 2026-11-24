import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ConteudoMudou,
  EdicaoNaoConfirmada,
  FaltamPaginas,
  SegundoFatorVencido,
} from "@/modules/acervo/erros";
import {
  esquemaConferir,
  esquemaVerificar,
  MENSAGENS_FICHA,
  recusaDaConferencia,
  recusaDaVerificacao,
  redirecionaParaSegundoFator,
} from "@/modules/acervo/painel-fichas";

// Painel de fichas (ACER-07): a guarda de TODA Server Action (T-02-48), o contrato do que o navegador manda, e a tradução
// dos erros tipados do plano 05 nas mensagens do contrato de copy.

const caminho = join(process.cwd(), "src", "modules", "acervo", "acoes-ficha.ts");
const fonte = readFileSync(caminho, "utf8");
const arquivo = ts.createSourceFile("a.ts", fonte, ts.ScriptTarget.Latest, true);
const funcoes = arquivo.statements.filter((n): n is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(n),
);
const exportadas = funcoes.filter((f) =>
  f.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
);
const guardar = funcoes.find((f) => f.name?.text === "guardar");

describe("guarda das Server Actions do painel de fichas", () => {
  it("o arquivo é 'use server', só exporta as duas ações, ambas assíncronas", () => {
    expect(fonte).toMatch(/^"use server";/);
    expect(exportadas.map((f) => f.name?.text).sort()).toEqual([
      "conferirItemAction",
      "verificarFichaAction",
    ]);
    for (const f of exportadas)
      expect(
        f.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        f.name?.text,
      ).toBe(true);
  });

  it("toda ação chama a guarda como PRIMEIRA instrução do corpo, antes de ler o argumento", () => {
    for (const f of exportadas) {
      const primeira = f.body?.statements[0]?.getText() ?? "";
      expect(primeira, f.name?.text).toMatch(/await guardar\(\)/);
    }
  });

  it("a guarda chama exigirAdmin() antes de qualquer outra coisa", () => {
    expect(guardar).toBeDefined();
    const corpo = guardar?.body?.getText() ?? "";
    // O primeiro `await` do corpo é a chamada de exigirAdmin, e nada de leitura ou ação antes dele.
    const antes = corpo.slice(0, corpo.indexOf("exigirAdmin()")).replace(/await\s*$/, "");
    expect(corpo).toContain("exigirAdmin()");
    expect(antes).not.toMatch(/await|safeParse|\.parse\(/);
    // Quem não é Admin NÃO é engolido: só o redirecionamento ao segundo fator vira recusa; o resto sobe.
    expect(corpo).toMatch(/redirecionaParaSegundoFator\(erro, ROTA_SEGUNDO_FATOR\)/);
    expect(corpo).toMatch(/throw erro/);
  });

  it("controle do instrumento: a verificação acusa ação cuja primeira instrução é outra", () => {
    const ruim = ts.createSourceFile(
      "r.ts",
      "export async function a(d: unknown) { const x = d; await guardar(); }",
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = ruim.statements[0] as ts.FunctionDeclaration;
    expect(fn.body?.statements[0]?.getText()).not.toMatch(/await guardar\(\)/);
  });

  it("as duas ações escrevem só pelo módulo da verificação (funções do banco), nunca por SQL próprio", () => {
    expect(fonte).toContain("conferirItemUmaVez");
    expect(fonte).toContain("verificarFichaUmaVez");
    expect(fonte).not.toMatch(/insert into|update acervo|tx\.execute/i);
  });

  it("nenhuma ação devolve ou repassa o texto do erro do banco", () => {
    expect(fonte).not.toMatch(/\.message/);
  });
});

describe("o que o navegador manda", () => {
  const hash = "a".repeat(64);
  it("conferir: slug, id do item e hash na forma esperada", () => {
    expect(
      esquemaConferir.safeParse({
        slug: "obra-de-teste",
        itemId: "obra-de-teste/argumento-1",
        hash,
      }).success,
    ).toBe(true);
    for (const ruim of [
      { slug: "Obra", itemId: "x/y", hash },
      { slug: "obra", itemId: "", hash },
      { slug: "obra", itemId: "obra/argumento-1", hash: "curto" },
      { slug: "obra", itemId: "obra/argumento-1", hash: "'; drop table x;--" },
      { slug: "obra", itemId: "obra/argumento-1" },
    ])
      expect(esquemaConferir.safeParse(ruim).success).toBe(false);
  });
  it("verificar: o identificador da ficha é um uuid e o hash tem a forma esperada", () => {
    const fichaId = "3f2b8c1e-6a4d-4e7b-9c1d-2a5f8e0b7c13";
    expect(esquemaVerificar.safeParse({ slug: "obra", fichaId, hash }).success).toBe(true);
    for (const ruim of [
      { slug: "obra", fichaId: "não-é-uuid", hash },
      { slug: "obra", fichaId, hash: "" },
      { slug: "../obra", fichaId, hash },
    ])
      expect(esquemaVerificar.safeParse(ruim).success).toBe(false);
  });
});

describe("tradução dos erros tipados do plano 05", () => {
  it("segundo fator vencido leva a mensagem do contrato nas duas ações", () => {
    expect(recusaDaConferencia(new SegundoFatorVencido())?.mensagem).toBe(
      MENSAGENS_FICHA.segundoFatorVencido,
    );
    expect(recusaDaVerificacao(new SegundoFatorVencido())).toMatchObject({
      motivo: "segundo-fator",
      mensagem: "Sua verificação em duas etapas venceu. Confirme de novo para marcar a ficha.",
    });
  });
  it("conteúdo mudado pede para recarregar; edição não confirmada leva o texto novo; faltantes levam a contagem", () => {
    expect(recusaDaConferencia(new ConteudoMudou())?.motivo).toBe("mudou");
    expect(recusaDaVerificacao(new ConteudoMudou())?.motivo).toBe("mudou");
    expect(recusaDaVerificacao(new EdicaoNaoConfirmada())?.mensagem).toBe(
      "A edição consultada desta ficha ainda não foi confirmada. Corrija a edição no arquivo da ficha e recarregue antes de verificar.",
    );
    expect(recusaDaVerificacao(new FaltamPaginas(5))).toMatchObject({
      motivo: "faltam",
      faltam: 5,
      mensagem: "Faltam 5 páginas a conferir.",
    });
    expect(recusaDaVerificacao(new FaltamPaginas(1))?.mensagem).toBe("Falta 1 página a conferir.");
  });
  it("erro desconhecido não vira recusa (a ação registra e dá a mensagem geral)", () => {
    expect(recusaDaConferencia(new Error("boom"))).toBeNull();
    expect(recusaDaVerificacao("texto")).toBeNull();
  });
});

describe("redirecionamento ao segundo fator", () => {
  it("só o redirecionamento para a rota do segundo fator conta", () => {
    const r = (d: string) => Object.assign(new Error("NEXT_REDIRECT"), { digest: d });
    expect(
      redirecionaParaSegundoFator(
        r("NEXT_REDIRECT;replace;/admin/segundo-fator;307;"),
        "/admin/segundo-fator",
      ),
    ).toBe(true);
    expect(
      redirecionaParaSegundoFator(
        r("NEXT_REDIRECT;replace;/entrar?motivo=sessao;307;"),
        "/admin/segundo-fator",
      ),
    ).toBe(false);
    expect(
      redirecionaParaSegundoFator(r("NEXT_HTTP_ERROR_FALLBACK;404"), "/admin/segundo-fator"),
    ).toBe(false);
    expect(redirecionaParaSegundoFator(new Error("x"), "/admin/segundo-fator")).toBe(false);
    expect(redirecionaParaSegundoFator(null, "/admin/segundo-fator")).toBe(false);
  });
});
