import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as lerYaml } from "yaml";
import { derivar } from "../../../scripts/ingest/acervo-derivar";
import {
  type ArquivoOrigem,
  acharArquivoDoDerivado,
  lerOrigens,
  type OrigemAcervo,
} from "../../../scripts/ingest/acervo-origens";

// Obras que NUNCA entram no Acervo desta fase, com o motivo de cada uma (D-06: só texto com domínio público ou
// licença aberta, lida na origem; D-20: o Talmude só como ficha, Soncino e Rodkinson fora). A lista mora aqui, no
// teste. Onde se procura: nos DADOS do registro de origens e das Fontes (não nos comentários, que podem citar a
// obra proibida para explicar por que ela ficou fora).
const PROIBIDAS: { obra: string; termos: string[]; motivo: string }[] = [
  {
    obra: "Talmude de Soncino (Epstein, 1935-1948)",
    termos: ["soncino"],
    motivo: "D-20: o Talmude entra só como ficha (Schäfer)",
  },
  {
    obra: "Talmude de Rodkinson (1896-1918)",
    termos: ["rodkinson"],
    motivo: "D-20: fora desta fase; decisão do dono se quiser",
  },
  {
    obra: "Tomé na tradução de Lambdin (The Nag Hammadi Library in English, Robinson, 1977)",
    termos: ["lambdin", "nag hammadi library"],
    motivo: "D-06: tradução moderna protegida",
  },
  {
    obra: "Tomé na tradução de Patterson e Robinson (The Fifth Gospel, 1998)",
    termos: ["patterson"],
    motivo: "D-06: tradução moderna protegida",
  },
  {
    obra: "Evangelho de Judas",
    termos: ["evangelho de judas", "gospel of judas"],
    motivo: "D-06: tradução moderna protegida ou sem declaração lida na origem",
  },
  {
    obra: "Evangelho de Maria",
    termos: ["evangelho de maria", "gospel of mary"],
    motivo: "D-06: tradução moderna protegida ou sem declaração lida na origem",
  },
  {
    obra: "Evangelho de Filipe",
    termos: ["evangelho de filipe", "gospel of philip"],
    motivo: "D-06: tradução moderna protegida ou sem declaração lida na origem",
  },
];

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FONTES = path.join(RAIZ, "content", "acervo", "fontes");

function yamlsDe(pasta: string): string[] {
  let entradas: import("node:fs").Dirent[];
  try {
    entradas = readdirSync(pasta, { withFileTypes: true });
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw erro;
  }
  return entradas.flatMap((e) =>
    e.isDirectory()
      ? yamlsDe(path.join(pasta, e.name))
      : /\.ya?ml$/.test(e.name)
        ? [path.join(pasta, e.name)]
        : [],
  );
}

/** Onde cada dado mora e o seu texto (só dados, já interpretados), em minúsculas. */
type Dado = { onde: string; texto: string };
const dadosReais = (): Dado[] => [
  { onde: "data/acervo-origens.yaml", texto: JSON.stringify(lerOrigens()).toLowerCase() },
  ...yamlsDe(PASTA_FONTES).map((arquivo) => ({
    onde: path.relative(RAIZ, arquivo),
    texto: JSON.stringify(lerYaml(readFileSync(arquivo, "utf8"))).toLowerCase(),
  })),
];

function citacoesProibidas(dados: Dado[]): string[] {
  const achados: string[] = [];
  for (const { obra, termos, motivo } of PROIBIDAS)
    for (const termo of termos)
      for (const { onde, texto } of dados)
        if (texto.includes(termo)) achados.push(`${obra} ("${termo}" em ${onde}) — ${motivo}`);
  return achados;
}

describe("obras cuja licença não vale para o Acervo nunca são citadas pelo registro nem pelas Fontes", () => {
  it("a lista nomeia cada obra proibida com o motivo, citando D-06 ou D-20", () => {
    expect(PROIBIDAS.length).toBeGreaterThanOrEqual(7);
    for (const { obra, termos, motivo } of PROIBIDAS) {
      expect(obra.length).toBeGreaterThan(3);
      expect(termos.length).toBeGreaterThan(0);
      expect(motivo, obra).toMatch(/D-06|D-20/);
    }
  });

  it("nenhuma origem do registro nem Fonte em content/acervo/fontes cita uma obra proibida", () => {
    const achados = citacoesProibidas(dadosReais());
    expect(achados, achados.join("\n")).toEqual([]);
  });

  it("controle negativo: o detector acusa CADA obra proibida posta no dado, com o motivo dela", () => {
    for (const { obra, termos, motivo } of PROIBIDAS) {
      const achados = citacoesProibidas([{ onde: "registro de teste", texto: `x ${termos[0]} y` }]);
      expect(achados, obra).toHaveLength(1);
      expect(achados[0], obra).toContain(motivo);
    }
    // e não acusa um dado limpo
    expect(
      citacoesProibidas([{ onde: "limpo", texto: "evangelho de tome, mattison, melmoth" }]),
    ).toEqual([]);
  });

  it("comentário do registro que cita a obra proibida para explicar a exclusão não é dado: não acusa", () => {
    const dado = {
      slug: "x",
      verificador: { tradutores: ["Mark M. Mattison"] },
      licenca: "domínio público",
    };
    const achados = citacoesProibidas([{ onde: "x", texto: JSON.stringify(dado).toLowerCase() }]);
    expect(achados).toEqual([]);
  });
});

describe("os dois Evangelhos de Tomé nunca se confundem (Pitfall 5)", () => {
  const origens = lerOrigens();

  it("`evangelho-de-tome` (114 ditos, Nag Hammadi II,2) vem só da página do Mattison, em HTML", () => {
    const achado = acharArquivoDoDerivado(origens, "evangelho-de-tome");
    expect(achado?.origemId).toBe("gospels-net-tome-mattison");
    expect(achado?.origem.formato).toBe("html");
    expect(achado?.arquivo.id).toBe("thomas.html");
    // 114 ditos mais o Prólogo (unidade própria, ref `prologo`) = 115 unidades, fato conferido pelo `acervo:verify`
    // (paragrafos_total), e os extremos da numeração também
    expect(achado?.origem.esperado.paragrafos_total).toBe(115);
    expect(achado?.origem.esperado.paragrafos.map((p) => p.ref)).toEqual(
      expect.arrayContaining(["prologo", "1", "47", "114"]),
    );
    // a dedicação é do tradutor, lida na página
    expect(achado?.origem.verificador.licenca).toContain("committed to the public domain");
    expect(achado?.origem.verificador.tradutores).toEqual(["Mark M. Mattison"]);
  });

  it("`evangelho-da-infancia-de-tome` é OUTRO slug (ANF08): ou ainda não está no registro, ou vem de outra origem", () => {
    const tome = acharArquivoDoDerivado(origens, "evangelho-de-tome");
    const infancia = acharArquivoDoDerivado(origens, "evangelho-da-infancia-de-tome");
    expect(tome).not.toBeNull();
    if (infancia) {
      expect(infancia.origemId).not.toBe(tome?.origemId);
      expect(infancia.arquivo.id).not.toBe(tome?.arquivo.id);
    }
    // nenhum arquivo do Mattison tem slug que comece com "evangelho-da-infancia"
    for (const a of origens["gospels-net-tome-mattison"]?.arquivos ?? [])
      expect(a.slug.startsWith("evangelho-da-infancia")).toBe(false);
    // os dois ids são diferentes um do outro, por construção
    expect(new Set(["evangelho-de-tome", "evangelho-da-infancia-de-tome"]).size).toBe(2);
  });
});

describe("decisões de licença lidas na origem (plano 02-27)", () => {
  const origens = lerOrigens();

  it("do Gutenberg só se baixa pelo espelho: nenhum endereço do registro aponta para o endereço principal", () => {
    const enderecos = Object.values(origens).flatMap((o) => [
      ...o.arquivos.map((a) => a.url),
      o.fonte,
      o.url_licenca,
    ]);
    for (const url of enderecos)
      expect(url, url).not.toMatch(/\/\/([a-z0-9-]+\.)*gutenberg\.org\//);
    for (const id of ["gutenberg-plinio-2811", "gutenberg-suetonio-6400"]) {
      const o = origens[id] as OrigemAcervo;
      expect(o.arquivos[0]?.url.startsWith("https://gutenberg.pglaf.org/")).toBe(true);
      expect(o.fonte.startsWith("https://gutenberg.pglaf.org/")).toBe(true);
    }
  });

  it("Suetônio e James 1924 estão barrados por licença não provada, com o motivo no registro", () => {
    for (const id of ["gutenberg-suetonio-6400", "internet-archive-james-1924"]) {
      const o = origens[id] as OrigemAcervo;
      expect(o.publicavel, id).toBe(false);
      expect(o.motivo, id).toBe("licença não provada na origem");
      expect(o.licenca.toLowerCase(), id).toContain("não provada");
    }
    // James: o item do Internet Archive declara CC BY-NC-ND, que não é licença aberta
    expect(origens["internet-archive-james-1924"]?.licenca).toContain("CC BY-NC-ND");
    expect(origens["internet-archive-james-1924"]?.formato).toBe("texto-ocr");
  });

  it("o derivador recusa Suetônio e James pela bandeira `publicavel`, haja ou não bruto em cache", () => {
    const bruto = new TextEncoder().encode("texto qualquer");
    const sha256 = createHash("sha256").update(bruto).digest("hex");
    for (const slug of ["suetonio-doze-cesares", "evangelhos-perdidos-fragmentos"]) {
      const achado = acharArquivoDoDerivado(origens, slug) as {
        origemId: string;
        origem: OrigemAcervo;
        arquivo: ArquivoOrigem;
      };
      expect(achado, slug).not.toBeNull();
      expect(() => derivar({ ...achado, bruto, sha256Lock: sha256 })).toThrow(
        /não é publicável \(licença não provada na origem\)/,
      );
    }
  });

  it("Plínio e Mattison estão publicáveis, cada um com a frase de licença que o próprio arquivo tem de trazer", () => {
    const plinio = origens["gutenberg-plinio-2811"] as OrigemAcervo;
    expect(plinio.publicavel).toBe(true);
    expect(plinio.verificador.licenca).toBe(
      "Creating the works from public domain print editions means that no one owns a United States copyright in these works",
    );
    expect(plinio.verificador.tradutores).toEqual(["William Melmoth", "F. C. T. Bosanquet"]);
    expect(plinio.correspondencia_refs).toEqual({
      "trajano.XCVII": "10.96",
      "trajano.XCVIII": "10.97",
    });
    const mattison = origens["gospels-net-tome-mattison"] as OrigemAcervo;
    expect(mattison.publicavel).toBe(true);
    expect(mattison.verificador.licenca).toContain("has been committed to the public domain");
  });

  it("toda origem publicável diz por quê, e toda barrada diz por quê", () => {
    for (const [id, o] of Object.entries(origens)) expect(o.motivo.length, id).toBeGreaterThan(10);
    expect(Object.keys(origens).sort()).toEqual(
      expect.arrayContaining([
        "gutenberg-plinio-2811",
        "gutenberg-suetonio-6400",
        "gospels-net-tome-mattison",
        "internet-archive-james-1924",
      ]),
    );
  });
});
