import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ErroDeBanco } from "@/db/erro-banco";
import {
  esquemaAprovar,
  lerLimite,
  MENSAGENS_GRAUS,
  mensagemDeSucesso,
  textoDaMeta,
} from "@/modules/acervo/painel-graus";
import { recusaDaAprovacao } from "@/modules/acervo/recusa-da-aprovacao";

// Painel de graus propostos (ACER-06, ACER-10, D-04): a guarda de TODA Server Action (T-02-57), o contrato do que o
// navegador manda e a tradução dos códigos de `acervo.aprovar_afirmacao` nas mensagens do contrato.

const caminho = join(process.cwd(), "src", "modules", "acervo", "acoes-graus.ts");
const fonte = readFileSync(caminho, "utf8");
const arquivo = ts.createSourceFile("a.ts", fonte, ts.ScriptTarget.Latest, true);
const funcoes = arquivo.statements.filter((n): n is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(n),
);
const exportadas = funcoes.filter((f) =>
  f.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
);
const guardar = funcoes.find((f) => f.name?.text === "guardar");

describe("guarda da Server Action do painel de graus", () => {
  it("o arquivo é 'use server' e só exporta a ação de aprovar (sem rejeitar, sem lote)", () => {
    expect(fonte).toMatch(/^"use server";/);
    expect(exportadas.map((f) => f.name?.text)).toEqual(["aprovarGrauAction"]);
    for (const f of exportadas)
      expect(
        f.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        f.name?.text,
      ).toBe(true);
  });

  it("a ação chama a guarda como PRIMEIRA instrução do corpo, antes de ler o argumento", () => {
    for (const f of exportadas) {
      const primeira = f.body?.statements[0]?.getText() ?? "";
      expect(primeira, f.name?.text).toMatch(/await guardar\(\)/);
    }
  });

  it("a guarda chama exigirAdmin() antes de qualquer outra coisa e não engole o que não é segundo fator", () => {
    expect(guardar).toBeDefined();
    const corpo = guardar?.body?.getText() ?? "";
    const antes = corpo.slice(0, corpo.indexOf("exigirAdmin()")).replace(/await\s*$/, "");
    expect(corpo).toContain("exigirAdmin()");
    expect(antes).not.toMatch(/await|safeParse|\.parse\(/);
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

  it("escreve só pelo módulo da aprovação (função do banco), nunca por SQL próprio, e nunca devolve o erro do banco", () => {
    expect(fonte).toContain("aprovarAfirmacao");
    expect(fonte).not.toMatch(/insert into|update acervo|tx\.execute/i);
    expect(fonte).not.toMatch(/\.message/);
  });
});

describe("o que o navegador manda", () => {
  const ok = {
    afirmacaoId: "pc02-a2",
    textoHash: "a".repeat(64),
    citacoesHash: "b".repeat(64),
    grau: "posicao-majoritaria",
  };
  it("controle positivo: id, os dois hashes e um Grau da lista", () => {
    expect(esquemaAprovar.safeParse(ok).success).toBe(true);
    for (const grau of ["consenso", "posicao-majoritaria", "disputada"])
      expect(esquemaAprovar.safeParse({ ...ok, grau }).success).toBe(true);
  });
  it.each([
    ["Grau fora da lista", { ...ok, grau: "certo" }],
    ["Grau com maiúscula", { ...ok, grau: "Consenso" }],
    ["rejeitar não é um Grau", { ...ok, grau: "rejeitada" }],
    ["id vazio", { ...ok, afirmacaoId: "" }],
    ["id com barra", { ...ok, afirmacaoId: "../x" }],
    ["id com maiúscula", { ...ok, afirmacaoId: "PC02-A2" }],
    ["hash do texto curto", { ...ok, textoHash: "abc" }],
    ["hash do texto em maiúsculas", { ...ok, textoHash: "A".repeat(64) }],
    ["hash do conjunto com injeção", { ...ok, citacoesHash: "'; drop table x;--" }],
    [
      "sem o hash do conjunto",
      { afirmacaoId: ok.afirmacaoId, textoHash: ok.textoHash, grau: ok.grau },
    ],
    ["não é objeto", "x"],
    ["nulo", null],
  ])("recusa %s", (_nome, dados) => {
    expect(esquemaAprovar.safeParse(dados).success).toBe(false);
  });
});

describe("tradução dos códigos de aprovar_afirmacao", () => {
  const id = "pc02-a2";
  it("42501: segundo fator vencido, com a ação de confirmar", () => {
    expect(recusaDaAprovacao(new ErroDeBanco("42501"), id)).toMatchObject({
      ok: false,
      afirmacaoId: id,
      motivo: "segundo-fator",
      mensagem: MENSAGENS_GRAUS.segundoFatorVencido,
    });
  });
  it("40001: a frase mudou depois da proposta", () => {
    expect(recusaDaAprovacao(new ErroDeBanco("40001"), id)).toMatchObject({
      motivo: "mudou",
      mensagem: "Esta frase mudou depois da proposta. Recarregue as propostas.",
    });
  });
  it("P0003 (alvo que não sustenta) e P0002 (sem Citação) têm a frase própria", () => {
    expect(recusaDaAprovacao(new ErroDeBanco("P0003"), id)?.motivo).toBe("nao-sustentada");
    expect(recusaDaAprovacao(new ErroDeBanco("P0002"), id)?.motivo).toBe("sem-citacao");
  });
  it("erro desconhecido, de outro tipo e 22023 não viram recusa (a ação registra e dá a mensagem geral)", () => {
    expect(recusaDaAprovacao(new ErroDeBanco("22023"), id)).toBeNull();
    expect(recusaDaAprovacao(new ErroDeBanco("0A000"), id)).toBeNull();
    expect(recusaDaAprovacao(new Error("boom"), id)).toBeNull();
    expect(recusaDaAprovacao("texto", id)).toBeNull();
  });
  it("nenhuma mensagem leva texto livre (a frase, a justificativa, o trecho)", () => {
    for (const m of Object.values(MENSAGENS_GRAUS)) expect(m).not.toMatch(/\{|\$/);
  });
});

describe("mensagens e limites", () => {
  it("sucesso e meta saem como o contrato", () => {
    expect(mensagemDeSucesso("Consenso")).toBe(
      "Grau aprovado: Consenso. A frase passa a mostrar a Citação no Estudo.",
    );
    expect(textoDaMeta(3, 66)).toBe("3 de 66 Afirmações com Citação aprovada");
  });
  it("lerLimite: múltiplo de 20 entre 20 e o teto; o resto vale 20", () => {
    expect(lerLimite("40")).toBe(40);
    expect(lerLimite(["60", "x"])).toBe(60);
    for (const v of [undefined, "", "0", "19", "25", "-20", "1e3", "999999", "420", "20.0", {}])
      expect(lerLimite(v)).toBe(20);
  });
});
