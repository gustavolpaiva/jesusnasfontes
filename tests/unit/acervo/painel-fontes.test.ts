import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ErroDeBanco } from "@/db/erro-banco";
import { traduzirErroDoPainel } from "@/modules/acervo/erros-painel";
import {
  errosPorCampo,
  esquemaFonteFormulario,
  listaDePalavras,
  listaEmTexto,
  MENSAGENS,
  rotuloDoCampoEmConflito,
  slugDoTitulo,
} from "@/modules/acervo/schemas-painel";

// Painel de Fontes (ACER-08): o contrato do formulário, a tradução das recusas do banco nas mensagens do contrato de
// copy e a guarda de TODA Server Action do painel (exigirAdmin antes de qualquer outra coisa).

const valido = {
  modo: "criar",
  titulo: "Obra de teste",
  autor: "",
  epoca: "",
  nivel: "primaria",
  tradicao: "",
  idioma: "pt",
  tipo_texto: "integral",
  obra_protegida: false,
  origem_nome: "",
  origem_url: "https://exemplo.invalid/obra",
  licenca: "dp-declarado-pela-origem",
  licenca_url: "",
  tradutor: "",
  traducao_ano: "",
  edicao: "",
  traduzida_por_nos: false,
  limites_pt: "",
  publicada: false,
  secoes: [],
};

describe("contrato do formulário de Fonte", () => {
  it("aceita o formulário válido e o controle negativo de cada campo recusa com a mensagem do contrato", () => {
    expect(esquemaFonteFormulario.safeParse(valido).success).toBe(true);
    const r = (parte: Record<string, unknown>) =>
      esquemaFonteFormulario.safeParse({ ...valido, ...parte });

    const http = r({ origem_url: "http://exemplo.invalid" });
    expect(http.success).toBe(false);
    if (!http.success) expect(errosPorCampo(http.error)).toEqual({ origem_url: MENSAGENS.https });
    const lic = r({ licenca_url: "ftp://x" });
    if (!lic.success) expect(errosPorCampo(lic.error)).toEqual({ licenca_url: MENSAGENS.https });
    else throw new Error("licenca_url ftp deveria ser recusada");

    expect(r({ titulo: "   " }).success).toBe(false);
    expect(r({ licenca: "qualquer-coisa" }).success).toBe(false);
    expect(r({ traducao_ano: "17x7" }).success).toBe(false);
    expect(r({ traducao_ano: "1737" }).success).toBe(true);
    expect(r({ campo_extra: 1 }).success).toBe(false);
  });

  it("não decide ACER-09: obra protegida com texto integral passa pela forma (quem recusa é o banco)", () => {
    expect(esquemaFonteFormulario.safeParse({ ...valido, obra_protegida: true }).success).toBe(
      true,
    );
    // Texto integral sem licença nem origem também passa: a mensagem de licença vem da recusa do banco.
    expect(
      esquemaFonteFormulario.safeParse({ ...valido, licenca: "", origem_url: "" }).success,
    ).toBe(true);
  });

  it("leitura confessional exige a tradição (a forma); editar exige o endereço", () => {
    const c = esquemaFonteFormulario.safeParse({ ...valido, nivel: "confessional" });
    expect(c.success).toBe(false);
    if (!c.success) expect(errosPorCampo(c.error)).toEqual({ tradicao: MENSAGENS.tradicao });
    expect(
      esquemaFonteFormulario.safeParse({ ...valido, nivel: "confessional", tradicao: "Católica" })
        .success,
    ).toBe(true);
    expect(esquemaFonteFormulario.safeParse({ ...valido, modo: "editar" }).success).toBe(false);
    // A edição exige o endereço E a revisão que o formulário leu; sem a revisão o banco não teria como recusar a velha.
    const semRevisao = esquemaFonteFormulario.safeParse({
      ...valido,
      modo: "editar",
      slug: "obra",
    });
    expect(semRevisao.success).toBe(false);
    expect(
      esquemaFonteFormulario.safeParse({ ...valido, modo: "editar", slug: "obra", revisao: 3 })
        .success,
    ).toBe(true);
  });

  it("seção sem título ou sem texto é recusada com o caminho do campo", () => {
    const r = esquemaFonteFormulario.safeParse({
      ...valido,
      secoes: [{ cid: "c1", titulo: "", texto: "  ", resumo_pt: "", palavras_chave_pt: "" }],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(Object.keys(errosPorCampo(r.error)).sort()).toEqual([
        "secoes-0-texto",
        "secoes-0-titulo",
      ]);
  });

  it("seção que já tem endereço precisa da revisão que o formulário viu; a nova não tem nenhum dos dois; o cid é obrigatório", () => {
    const base = { cid: "c1", titulo: "S", texto: "x", resumo_pt: "", palavras_chave_pt: "" };
    const com = (secao: Record<string, unknown>) =>
      esquemaFonteFormulario.safeParse({ ...valido, secoes: [secao] }).success;
    expect(com(base)).toBe(true);
    expect(com({ ...base, slug: "secao-1" })).toBe(false);
    expect(com({ ...base, slug: "secao-1", revisao: 0 })).toBe(true);
    expect(com({ titulo: "S", texto: "x", resumo_pt: "", palavras_chave_pt: "" })).toBe(false);
  });

  it("ajudantes: endereço da Fonte, palavras-chave e nomes dos campos em conflito", () => {
    expect(slugDoTitulo("Antiguidades Judaicas, Livro 18")).toBe("antiguidades-judaicas-livro-18");
    expect(slugDoTitulo("  Ação & Reação!  ")).toBe("acao-reacao");
    expect(slugDoTitulo("???")).toBe("fonte");
    expect(listaDePalavras("Jesus, Pilatos,\n cristãos , Jesus,, ")).toEqual([
      "Jesus",
      "Pilatos",
      "cristãos",
    ]);
    expect(rotuloDoCampoEmConflito("limites_pt")).toBe("O que esta Fonte não pode dizer");
    expect(rotuloDoCampoEmConflito("18:resumo_pt")).toBe("Resumo em português (seção 18)");
    expect(listaEmTexto(["a", "b", "c"])).toBe("a, b e c");
    expect(listaEmTexto(["a"])).toBe("a");
  });
});

describe("tradução da recusa do banco (T-02-45: nunca texto do banco)", () => {
  it("23514 pela restrição de ACER-09, pelo gatilho (sem restrição) e pela de licença", () => {
    expect(
      traduzirErroDoPainel(new ErroDeBanco("23514", "fonte_obra_protegida_sem_texto_integral")),
    ).toEqual({ tipo: "campo", campo: "obra_protegida", mensagem: MENSAGENS.obraProtegida });
    expect(traduzirErroDoPainel(new ErroDeBanco("23514"))).toEqual({
      tipo: "campo",
      campo: "obra_protegida",
      mensagem: MENSAGENS.obraProtegida,
    });
    expect(
      traduzirErroDoPainel(new ErroDeBanco("23514", "fonte_texto_integral_exige_licenca_e_origem")),
    ).toEqual({ tipo: "campo", campo: "licenca", mensagem: MENSAGENS.licenca });
    // Outra restrição de linha não leva a mensagem de nenhuma das duas.
    expect(traduzirErroDoPainel(new ErroDeBanco("23514", "fonte_slug_formato"))).toEqual({
      tipo: "geral",
      mensagem: MENSAGENS.servidor,
    });
  });

  it("42501 é o segundo fator; 23505 do endereço é repetição; o resto é a mensagem de servidor", () => {
    expect(traduzirErroDoPainel(new ErroDeBanco("42501"))).toEqual({ tipo: "segundo-fator" });
    expect(traduzirErroDoPainel(new ErroDeBanco("23505", "fonte_slug_unico"))).toEqual({
      tipo: "slug-repetido",
    });
    expect(traduzirErroDoPainel(new ErroDeBanco("P0006"))).toMatchObject({ campo: "tradicao" });
    // Fonte alterada por outra pessoa ou pela carga desde a leitura: aviso próprio, nunca a mensagem de servidor.
    expect(traduzirErroDoPainel(new ErroDeBanco("40001"))).toEqual({
      tipo: "geral",
      mensagem: MENSAGENS.revisao,
    });
    expect(traduzirErroDoPainel(new ErroDeBanco("08006"))).toEqual({
      tipo: "geral",
      mensagem: MENSAGENS.servidor,
    });
  });

  it("erro que não veio do banco nunca vaza o texto: sai a mensagem fixa", () => {
    const t = traduzirErroDoPainel(new Error("senha=hunter2 select * from acervo.fonte"));
    expect(t).toEqual({ tipo: "geral", mensagem: MENSAGENS.servidor });
    expect(JSON.stringify(t)).not.toContain("hunter2");
  });

  it("as mensagens do contrato de copy estão literais", () => {
    expect(MENSAGENS.obraProtegida).toBe(
      "Obra protegida não pode ter texto integral. Guarde só a ficha, com trechos curtos de até 300 caracteres.",
    );
    expect(MENSAGENS.licenca).toBe(
      "Texto integral precisa de licença e de endereço https da origem.",
    );
    expect(MENSAGENS.https).toBe("O endereço precisa começar com https://.");
    expect(MENSAGENS.servidor).toBe(
      "Não conseguimos salvar a Fonte. O que você digitou continua aqui. Tente de novo.",
    );
  });
});

describe("guarda das Server Actions do painel", () => {
  const caminho = join(process.cwd(), "src", "modules", "acervo", "acoes-fonte.ts");
  const arquivo = ts.createSourceFile(
    "a.ts",
    readFileSync(caminho, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const exportadas = arquivo.statements.filter(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) &&
      !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );

  it("o arquivo tem as quatro ações e só exporta funções assíncronas", () => {
    expect(exportadas.map((f) => f.name?.text).sort()).toEqual([
      "reverterAoArquivo",
      "salvarFonte",
      "salvarFonteDoArquivo",
      "salvarResumoDeSecao",
    ]);
    for (const f of exportadas)
      expect(
        f.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        f.name?.text,
      ).toBe(true);
  });

  it("toda ação chama exigirAdmin() como PRIMEIRA instrução do corpo, antes de ler o argumento", () => {
    for (const f of exportadas) {
      const primeira = f.body?.statements[0]?.getText() ?? "";
      expect(primeira, `${f.name?.text}`).toMatch(/await exigirAdmin\(\)/);
    }
  });

  it("controle do instrumento: a verificação acusa ação cuja primeira instrução é outra", () => {
    const ruim = ts.createSourceFile(
      "r.ts",
      "export async function a(d: unknown) { const x = d; await exigirAdmin(); }",
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = ruim.statements[0] as ts.FunctionDeclaration;
    expect(fn.body?.statements[0]?.getText()).not.toMatch(/await exigirAdmin\(\)/);
  });

  it("nenhuma ação devolve ou repassa o texto do erro do banco", () => {
    const fonte = readFileSync(caminho, "utf8");
    expect(fonte).not.toMatch(/\.message/);
    expect(fonte).not.toMatch(/mensagem:\s*String\(/);
  });
});
