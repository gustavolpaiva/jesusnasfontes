import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ErroLicenca,
  exigirDedicacaoDominioPublico,
  exigirLicencaGutenberg,
  exigirLicencaThml,
  exigirTraducaoTei,
  lerCabecalhoTei,
  lerCabecalhoThml,
} from "../../../scripts/ingest/acervo-licenca";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const xml = readFileSync(path.join(FIXTURES, "perseus-josefo-trecho.xml"), "utf8");
const WHISTON = { tradutores: ["William Whiston"], licenca: "CC BY-SA" };

describe("exigirTraducaoTei", () => {
  it("lê tradutor, licença e ano de edição do cabeçalho", () => {
    const c = lerCabecalhoTei(xml);
    expect(c.tradutores).toEqual(["William Whiston"]);
    expect(c.licenca).toContain("Creative Commons Attribution-ShareAlike (CC BY-SA)");
    expect(c.licencaUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(c.anos).toContain("1856");
  });

  it("controle positivo: o tradutor e a licença esperados passam", () => {
    expect(() => exigirTraducaoTei(xml, WHISTON)).not.toThrow();
  });

  it("controle negativo: outro tradutor esperado reprova (armadilha do Perseus)", () => {
    expect(() =>
      exigirTraducaoTei(xml, { tradutores: ["Austin Morris Harmon"], licenca: "CC BY-SA" }),
    ).toThrow(ErroLicenca);
  });

  it("controle negativo: cabeçalho com tradutor a mais reprova", () => {
    const outro = xml.replace(
      '<editor role="translator">William Whiston</editor>     \n        <sponsor>',
      '<editor role="translator">William Whiston</editor><editor role="translator">Austin Morris Harmon</editor><sponsor>',
    );
    expect(outro).not.toBe(xml);
    expect(() => exigirTraducaoTei(outro, WHISTON)).toThrow(/tradutor/);
  });

  it("licença diferente da esperada reprova", () => {
    expect(() => exigirTraducaoTei(xml, { ...WHISTON, licenca: "CC BY-NC" })).toThrow(ErroLicenca);
  });

  it("cabeçalho sem licença reprova; arquivo sem cabeçalho reprova", () => {
    const sem = xml.replace(/<licence[\s\S]*?<\/licence>/, "");
    expect(sem).not.toBe(xml);
    expect(() => exigirTraducaoTei(sem, WHISTON)).toThrow(/sem licença/);
    expect(() => exigirTraducaoTei("<TEI/>", WHISTON)).toThrow(ErroLicenca);
  });
});

const lucianoEng2 = readFileSync(path.join(FIXTURES, "perseus-luciano-eng2-cabecalho.xml"), "utf8");
const lucianoEng4 = readFileSync(path.join(FIXTURES, "perseus-luciano-eng4-trecho.xml"), "utf8");
const tacito = readFileSync(path.join(FIXTURES, "perseus-tacito-trecho.xml"), "utf8");
const FOWLER = {
  tradutores: ["Henry Watson Fowler", "Francis George Fowler"],
  licenca: "CC BY-SA",
};

describe("Luciano: o cabeçalho CC BY-SA não prova o direito da tradução (Pitfall 1, T-02-12)", () => {
  it("controle negativo: o perseus-eng2 real (Harmon, 1936) reprova e a mensagem cita o tradutor lido", () => {
    const c = lerCabecalhoTei(lucianoEng2);
    expect(c.tradutores).toEqual(["Austin Morris Harmon"]);
    expect(c.anos).toContain("1936");
    // O cabeçalho do arquivo protegido DIZ CC BY-SA: só o tradutor o denuncia.
    expect(c.licenca).toContain("CC BY-SA");
    expect(() => exigirTraducaoTei(lucianoEng2, FOWLER)).toThrow(ErroLicenca);
    expect(() => exigirTraducaoTei(lucianoEng2, FOWLER)).toThrow(/Austin Morris Harmon/);
  });

  it("controle positivo: o perseus-eng4 real (Fowler e Fowler, 1905) passa", () => {
    const c = exigirTraducaoTei(lucianoEng4, FOWLER);
    expect(c.tradutores).toEqual(["Francis George Fowler", "Henry Watson Fowler"]);
    expect(c.anos).toContain("1905");
  });

  it("o eng4 não passa se o registro esperasse só um dos dois tradutores", () => {
    expect(() =>
      exigirTraducaoTei(lucianoEng4, { tradutores: ["Henry Watson Fowler"], licenca: "CC BY-SA" }),
    ).toThrow(ErroLicenca);
  });
});

describe("Tácito: licença da edição digital e o aviso do editorialDecl sobre a reimpressão de 1942", () => {
  const TACITO = {
    tradutores: ["Alfred John Church", "William Jackson Brodribb"],
    licenca: "Attribution-ShareAlike 4.0",
  };

  it("lê CC BY-SA 4.0, os dois tradutores e os anos 1869 e 1942 do cabeçalho", () => {
    const c = exigirTraducaoTei(tacito, TACITO);
    expect(c.licencaUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(c.anos).toEqual(expect.arrayContaining(["1869", "1942"]));
  });

  it("registra o aviso do editorialDecl: o texto parece seguir a reimpressão de 1942", () => {
    const c = lerCabecalhoTei(tacito);
    expect(c.avisoEditorial).toContain("substantially based on the 1942 reprint");
  });

  it("cabeçalho sem editorialDecl devolve aviso vazio (Josefo)", () => {
    expect(lerCabecalhoTei(xml).avisoEditorial).toBe("");
  });

  it("tradutor trocado reprova também em Tácito", () => {
    expect(() => exigirTraducaoTei(tacito, { ...TACITO, tradutores: ["William Whiston"] })).toThrow(
      ErroLicenca,
    );
  });
});

// ---- Gutenberg: a licença é lida nas DUAS BORDAS do próprio arquivo (plano 02-27) ----
// Fixtures reais (NOTICE.md): o Plínio #2811 traz o cabeçalho do Gutenberg e a licença na cauda; o Suetônio #6400
// não traz nada antes do marcador de início nem depois do marcador de fim. O arquivo declara ISO-8859-1.
const plinio = readFileSync(path.join(FIXTURES, "gutenberg-plinio-trecho.txt"), "latin1");
const suetonio = readFileSync(path.join(FIXTURES, "gutenberg-suetonio-bordas.txt"), "utf8");
const DECLARACAO_PG =
  "Creating the works from public domain print editions means that no one owns a United States copyright in these works";
const MELMOTH = { tradutores: ["William Melmoth", "F. C. T. Bosanquet"], licenca: DECLARACAO_PG };
const THOMSON = { tradutores: ["Alexander Thomson", "T.Forester"], licenca: DECLARACAO_PG };
/** Documento Gutenberg sintético: só as bordas interessam aqui. */
const gutenberg = (inicio: string, corpo: string, fim: string) =>
  `${inicio}\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${corpo}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\n${fim}`;

describe("exigirLicencaGutenberg: licença lida nas bordas do próprio arquivo", () => {
  it("controle positivo: o arquivo real do Plínio declara a edição impressa em domínio público e nomeia os tradutores", () => {
    const c = exigirLicencaGutenberg(plinio, MELMOTH);
    expect(c.licenca).toBe(
      "Creating the works from public domain print editions means that no one owns a United States copyright in these works, so the Foundation (and you!) can copy and distribute it in the United States without permission and without paying copyright royalties.",
    );
    expect(c.borda).toBe("fim");
    expect(c.tradutores).toEqual(["F. C. T. Bosanquet", "William Melmoth"]);
    expect(c.avisoEditorial).toBe("");
  });

  it("controle negativo: as bordas REAIS do Suetônio (#6400) não trazem declaração: licença não provada na origem", () => {
    let erro: unknown;
    try {
      exigirLicencaGutenberg(suetonio, THOMSON);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ErroLicenca);
    expect((erro as ErroLicenca).message).toMatch(/licença não provada na origem/);
    // código estruturado: é o que o `acervo:verify` usa para NÃO reprovar a origem já barrada por esse motivo
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
  });

  it("a declaração tem de estar numa das bordas: no corpo (dentro dos marcadores) não conta", () => {
    const noCorpo = gutenberg(
      "",
      `Prefácio.\n\n${DECLARACAO_PG}, so the Foundation can copy.\n\nFim.`,
      "",
    );
    let erro: unknown;
    try {
      exigirLicencaGutenberg(noCorpo, MELMOTH);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ErroLicenca);
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
    // o mesmo texto na borda inicial passa (com os tradutores na página de rosto, como no arquivo real)
    expect(
      exigirLicencaGutenberg(
        gutenberg(
          `${DECLARACAO_PG}, so the Foundation can copy.`,
          "Translated by William Melmoth. Revised by F. C. T. Bosanquet.",
          "",
        ),
        MELMOTH,
      ).borda,
    ).toBe("inicio");
  });

  it("declaração que não é a esperada reprova (frase parecida não basta)", () => {
    const outra = gutenberg(
      "This eBook is licensed under a Creative Commons license.",
      "Translated by William Melmoth. Revised by F. C. T. Bosanquet.",
      "",
    );
    expect(() => exigirLicencaGutenberg(outra, MELMOTH)).toThrow(ErroLicenca);
    // o registro esperar outra frase reprova mesmo no arquivo real
    expect(() =>
      exigirLicencaGutenberg(plinio, {
        ...MELMOTH,
        licenca: "This eBook is licensed under a Creative Commons license",
      }),
    ).toThrow(ErroLicenca);
  });

  it("tradutor esperado que o arquivo não nomeia reprova, citando quem faltou (armadilha do Perseus, de novo)", () => {
    expect(() =>
      exigirLicencaGutenberg(plinio, { ...MELMOTH, tradutores: ["Austin Morris Harmon"] }),
    ).toThrow(/Austin Morris Harmon/);
    expect(() =>
      exigirLicencaGutenberg(plinio, { ...MELMOTH, tradutores: ["William Melmoth"] }),
    ).not.toThrow();
  });

  it("a declaração é lida depois de normalizar espaços e quebras de linha, sem distinguir maiúsculas", () => {
    const quebrada = gutenberg(
      `  creating   the works from public domain\nprint editions means that no one owns\n\na United States copyright in these works; …`,
      "Translated by William Melmoth. Revised by F. C. T. Bosanquet.",
      "",
    );
    expect(exigirLicencaGutenberg(quebrada, MELMOTH).borda).toBe("inicio");
  });

  it("arquivo sem os marcadores do Gutenberg não tem borda onde ler: reprova", () => {
    expect(() =>
      exigirLicencaGutenberg(`${DECLARACAO_PG}. Translated by William Melmoth.`, MELMOTH),
    ).toThrow(ErroLicenca);
    expect(() =>
      exigirLicencaGutenberg(`${DECLARACAO_PG}. Translated by William Melmoth.`, MELMOTH),
    ).toThrow(/marcador/);
  });
});

// ---- gospels.net: a dedicação ao domínio público lida na página do tradutor (D-24) ----
const DEDICACAO =
  "The following translation has been committed to the public domain and may be freely copied and used, changed or unchanged, for any purpose.";
const MATTISON = { tradutores: ["Mark M. Mattison"], licenca: DEDICACAO };

describe("exigirDedicacaoDominioPublico: a dedicação do tradutor, lida na página", () => {
  const tome = readFileSync(path.join(FIXTURES, "gospels-tome-trecho.html"), "utf8");

  it("controle positivo: a página real do Mattison traz a dedicação inteira e o nome do tradutor", () => {
    const c = exigirDedicacaoDominioPublico(tome, MATTISON);
    expect(c.licenca).toBe(DEDICACAO);
    expect(c.tradutores).toEqual(["Mark M. Mattison"]);
  });

  it("o pedido do plano: a frase 'committed to the public domain' é o que se confere", () => {
    expect(() =>
      exigirDedicacaoDominioPublico(tome, {
        tradutores: ["Mark M. Mattison"],
        licenca: "committed to the public domain",
      }),
    ).not.toThrow();
  });

  it("página sem a frase lança ErroLicenca (licença não provada na origem)", () => {
    const sem = tome.replace("committed to the public domain", "licensed to its readers");
    expect(sem).not.toBe(tome);
    let erro: unknown;
    try {
      exigirDedicacaoDominioPublico(sem, MATTISON);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ErroLicenca);
    expect((erro as ErroLicenca).message).toMatch(/licença não provada na origem/);
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
  });

  it("frase que só existe dentro de script ou style não conta: vale o texto visível", () => {
    const escondida = `<!doctype html><html><head><script>var a = "${DEDICACAO}";</script><style>/* ${DEDICACAO} */</style></head><body><h3>by Mark M. Mattison</h3><p>Estas são as palavras.</p></body></html>`;
    expect(() => exigirDedicacaoDominioPublico(escondida, MATTISON)).toThrow(ErroLicenca);
  });

  it("frase partida por entidade ou por etiqueta conta: é o texto que o leitor vê", () => {
    const partida = `<!doctype html><html><body><h3>by Mark M. Mattison</h3><p>The following translation has been committed to the&nbsp;public <b>domain</b> and may be freely copied and used, changed or unchanged, for any purpose.</p></body></html>`;
    expect(exigirDedicacaoDominioPublico(partida, MATTISON).licenca).toBe(DEDICACAO);
  });

  it("dedicação de outro tradutor não serve: o nome esperado tem de estar na página", () => {
    expect(() =>
      exigirDedicacaoDominioPublico(tome, { ...MATTISON, tradutores: ["Thomas O. Lambdin"] }),
    ).toThrow(/Thomas O\. Lambdin/);
  });

  it("página sem a dedicação e sem tradutor reprova primeiro pela dedicação", () => {
    let erro: unknown;
    try {
      exigirDedicacaoDominioPublico("<html><body><p>Nada aqui.</p></body></html>", MATTISON);
    } catch (e) {
      erro = e;
    }
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
  });
});

// ───────────────────────── ThML (CCEL): DC.Rights no cabeçalho do próprio arquivo ─────────────────────────
const mara = readFileSync(path.join(FIXTURES, "ccel-anf08-mara.xml"), "utf8");
const lightfoot = readFileSync(path.join(FIXTURES, "ccel-lightfoot-trecho.xml"), "utf8");
const SCHAFF = { tradutores: ["Schaff, Philip (1819-1893)"], licenca: "Public Domain" };

describe("exigirLicencaThml: DC.Rights lido no cabeçalho do próprio arquivo (D-06)", () => {
  it("lê DC.Rights, DC.Publisher, os nomes do DC e as datas do cabeçalho real do ANF 8", () => {
    const c = lerCabecalhoThml(mara);
    expect(c.licenca).toBe("Public Domain");
    expect(c.editora).toBe("Grand Rapids, MI: Christian Classics Ethereal Library");
    expect(c.tradutores).toContain("Schaff, Philip (1819-1893)");
    expect(c.anos).toContain("2005-03-27");
  });

  it("controle positivo: 'Public Domain' e o editor esperado passam", () => {
    expect(() => exigirLicencaThml(mara, SCHAFF)).not.toThrow();
  });

  it("controle negativo: outro valor em DC.Rights reprova, citando o valor lido", () => {
    const trocado = mara.replace(
      "<DC.Rights>Public Domain</DC.Rights>",
      "<DC.Rights>All rights reserved</DC.Rights>",
    );
    expect(trocado).not.toBe(mara);
    expect(() => exigirLicencaThml(trocado, SCHAFF)).toThrow(ErroLicenca);
    expect(() => exigirLicencaThml(trocado, SCHAFF)).toThrow(/All rights reserved/);
  });

  it("controle negativo: sem DC.Rights, a licença não está provada na origem", () => {
    const sem = mara.replace("<DC.Rights>Public Domain</DC.Rights>", "<DC.Rights />");
    expect(sem).not.toBe(mara);
    let erro: unknown;
    try {
      exigirLicencaThml(sem, SCHAFF);
    } catch (e) {
      erro = e;
    }
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
  });

  it("DC.Rights só vale dentro da janela do cabeçalho (primeiros 20.000 caracteres)", () => {
    const sem = mara.replace("<DC.Rights>Public Domain</DC.Rights>", "<DC.Rights />");
    const longe = sem.replace(
      "</ThML>",
      `${"<p>enchimento</p>".repeat(2000)}<DC.Rights>Public Domain</DC.Rights></ThML>`,
    );
    expect(() => exigirLicencaThml(longe, SCHAFF)).toThrow(ErroLicenca);
  });

  it("a licença vale SÓ do primeiro ThML.head: cabeçalho principal sem licença + cabeçalho de obra interna em domínio público reprova", () => {
    const sem = mara.replace("<DC.Rights>Public Domain</DC.Rights>", "<DC.Rights />");
    expect(sem).not.toBe(mara);
    const interno = [
      "<ThML.head><electronicEdInfo><DC>",
      '<DC.Creator scheme="file-as" sub="Editor">Schaff, Philip (1819-1893)</DC.Creator>',
      "<DC.Rights>Public Domain</DC.Rights>",
      "</DC></electronicEdInfo></ThML.head>",
    ].join("");
    const comInterno = sem.replace(
      "</ThML.head>",
      `</ThML.head><ThML.body><div1>${interno}</div1>`,
    );
    expect(comInterno).not.toBe(sem);
    // o bloco interno cai bem antes dos 20.000 caracteres: antes da correção, a janela o aceitava
    expect(comInterno.indexOf(interno)).toBeLessThan(20_000);
    let erro: unknown;
    try {
      exigirLicencaThml(comInterno, SCHAFF);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ErroLicenca);
    expect((erro as ErroLicenca).codigo).toBe("sem_declaracao");
  });

  it("um criador que só existe num cabeçalho interno não satisfaz o nome esperado", () => {
    const interno =
      "<ThML.head><DC><DC.Creator>Outro, Autor</DC.Creator><DC.Rights>Public Domain</DC.Rights></DC></ThML.head>";
    const c = mara.replace("</ThML.head>", `</ThML.head><ThML.body><div1>${interno}</div1>`);
    expect(() =>
      exigirLicencaThml(c, { tradutores: ["Outro, Autor"], licenca: "Public Domain" }),
    ).toThrow(/Outro, Autor/);
  });

  it("nome esperado ausente do DC reprova, citando quem faltou", () => {
    expect(() =>
      exigirLicencaThml(mara, { tradutores: ["Harmon, Austin Morris"], licenca: "Public Domain" }),
    ).toThrow(/Harmon, Austin Morris/);
  });

  it("o cabeçalho real de Lightfoot (com DOCTYPE) passa com o nome lido no arquivo", () => {
    const c = exigirLicencaThml(lightfoot, {
      tradutores: ["Lightfoot, Joseph Barber (1828-1889)"],
      licenca: "Public Domain",
    });
    expect(c.editora).toBe("Grand Rapids, MI: Christian Classics Ethereal Library");
  });
});

// ───────────────────────── a licença vem do cabeçalho do DOCUMENTO, em toda família ─────────────────────────
describe("licença nunca vem de metadado de obra interna (classe)", () => {
  it("TEI: teiHeader que só aparece depois de abrir <text> não prova a licença do arquivo", () => {
    const interno = xml.slice(xml.indexOf("<teiHeader"), xml.indexOf("</teiHeader>") + 12);
    expect(interno).not.toBe("");
    const semCabecalho = `<TEI><text><body>${interno}</body></text></TEI>`;
    expect(() => exigirTraducaoTei(semCabecalho, WHISTON)).toThrow(ErroLicenca);
    // controle positivo: o mesmo bloco, na posição de cabeçalho, passa
    expect(() => exigirTraducaoTei(xml, WHISTON)).not.toThrow();
  });

  it("Gutenberg: marcador de fim citado no corpo não desloca a borda; a declaração no corpo não conta", () => {
    const decl = `${DECLARACAO_PG}, so the Foundation can copy it.`;
    const t = gutenberg(
      "William Melmoth F. C. T. Bosanquet",
      `texto\n*** END OF THE PROJECT GUTENBERG EBOOK Y ***\n${decl}`,
      "sem declaracao aqui",
    );
    expect(() => exigirLicencaGutenberg(t, MELMOTH)).toThrow(ErroLicenca);
    const ok = gutenberg("William Melmoth F. C. T. Bosanquet", "texto", decl);
    expect(() => exigirLicencaGutenberg(ok, MELMOTH)).not.toThrow();
  });
});

describe("estrutura vem dos eventos do parser, não de regex sobre o XML cru", () => {
  const SEM_LICENCA = mara.replace("<DC.Rights>Public Domain</DC.Rights>", "<DC.Rights />");

  it("TEI: comentário com <text> e </teiHeader> antes do cabeçalho não confunde a leitura", () => {
    const c = xml.replace(
      "<teiHeader",
      "<!-- O corpo começa em <text> depois do cabeçalho; fecha em </teiHeader>. --><teiHeader",
    );
    expect(c).not.toBe(xml);
    expect(() => exigirTraducaoTei(c, WHISTON)).not.toThrow();
    expect(lerCabecalhoTei(c)).toEqual(lerCabecalhoTei(xml));
  });

  it("TEI: CDATA com um cabeçalho falso depois do corpo é ignorado", () => {
    const falso =
      '<![CDATA[<teiHeader><editor role="translator">Falso</editor><licence>CC BY-SA</licence></teiHeader>]]>';
    const c = `<TEI><text><body><p>${falso}</p></body></text></TEI>`;
    expect(() => exigirTraducaoTei(c, { tradutores: ["Falso"], licenca: "CC BY-SA" })).toThrow(
      ErroLicenca,
    );
  });

  it("ThML: comentário com <ThML.body> antes do cabeçalho não encerra a captura", () => {
    const c = mara.replace("<ThML.head>", "<!-- <ThML.body> vem depois --><ThML.head>");
    expect(c).not.toBe(mara);
    expect(() => exigirLicencaThml(c, SCHAFF)).not.toThrow();
  });

  it("ThML: CDATA com um cabeçalho falso depois do corpo é ignorado", () => {
    const falso =
      "<![CDATA[<ThML.head><DC><DC.Creator>Schaff, Philip (1819-1893)</DC.Creator><DC.Rights>Public Domain</DC.Rights></DC></ThML.head>]]>";
    const c = SEM_LICENCA.replace("</ThML.head>", `</ThML.head><ThML.body><p>${falso}</p>`);
    expect(c).not.toBe(SEM_LICENCA);
    expect(() => exigirLicencaThml(c, SCHAFF)).toThrow(ErroLicenca);
  });
});
