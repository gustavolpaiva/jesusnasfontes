// Licença e tradutor lidos NO CABEÇALHO do próprio arquivo TEI (Perseus), nunca confiados ao registro (D-06).
// O cabeçalho "CC BY-SA" do Perseus é licença da EDIÇÃO DIGITAL: não prova que a tradução é de domínio público
// (caso Luciano `perseus-eng2`, Harmon 1936). Por isso o registro lista os tradutores esperados e a leitura
// reprova qualquer divergência. Lê só o que vem antes de `</teiHeader>`; o corpo nem é interpretado aqui.

import { Parser } from "htmlparser2";

export class ErroLicenca extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroLicenca";
  }
}

export type ExigenciaTei = {
  /** Todos os tradutores esperados; o cabeçalho tem de trazer exatamente este conjunto. */
  tradutores: readonly string[];
  /** Trecho que o texto da licença do cabeçalho tem de conter (sem distinguir maiúsculas). */
  licenca: string;
};

export type CabecalhoTei = {
  tradutores: string[];
  licenca: string;
  licencaUrl: string | null;
  anos: string[];
  /** Texto do `editorialDecl` do cabeçalho (vazio se não houver): o aviso da própria edição digital. */
  avisoEditorial: string;
};

const FIM_DO_CABECALHO = "</teiHeader>";

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** Lê tradutor(es), licença e ano de edição do cabeçalho TEI. Não valida: só lê. */
export function lerCabecalhoTei(xml: string): CabecalhoTei {
  const fim = xml.indexOf(FIM_DO_CABECALHO);
  if (fim < 0) throw new ErroLicenca("arquivo sem cabeçalho TEI (teiHeader)");
  const cabecalho = xml.slice(0, fim + FIM_DO_CABECALHO.length);

  const tradutores = new Set<string>();
  const anos: string[] = [];
  let licenca = "";
  let licencaUrl: string | null = null;
  let capturando: "tradutor" | "licenca" | "ano" | null = null;
  let imprint = 0;
  let texto = "";
  let editorial = 0;
  let paragrafoEditorial = "";
  const avisos: string[] = [];

  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        if (nome === "editor" && atributos.role === "translator") {
          capturando = "tradutor";
          texto = "";
        } else if (nome === "licence") {
          capturando = "licenca";
          texto = "";
          licencaUrl = atributos.target ?? null;
        } else if (nome === "editorialDecl") {
          editorial++;
        } else if (nome === "p" && editorial > 0) {
          paragrafoEditorial = "";
        } else if (nome === "imprint") {
          imprint++;
        } else if (nome === "date" && imprint > 0) {
          capturando = "ano";
          texto = "";
        }
      },
      ontext(dados) {
        if (capturando) texto += dados;
        if (editorial > 0) paragrafoEditorial += dados;
      },
      onclosetag(nome) {
        if (nome === "imprint") imprint = Math.max(0, imprint - 1);
        if (nome === "p" && editorial > 0) {
          const t = compactar(paragrafoEditorial);
          if (t) avisos.push(t);
          paragrafoEditorial = "";
        }
        if (nome === "editorialDecl") editorial = Math.max(0, editorial - 1);
        if (capturando === "tradutor" && nome === "editor") {
          const t = compactar(texto);
          if (t) tradutores.add(t);
          capturando = null;
        } else if (capturando === "licenca" && nome === "licence") {
          licenca = compactar(texto);
          capturando = null;
        } else if (capturando === "ano" && nome === "date") {
          const t = compactar(texto);
          if (t) anos.push(t);
          capturando = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(cabecalho);
  parser.end();

  return {
    tradutores: [...tradutores].sort(),
    licenca,
    licencaUrl,
    anos,
    avisoEditorial: avisos.join(" "),
  };
}

/**
 * Confere o cabeçalho contra o que o registro espera. Lança `ErroLicenca` (nomeando o que divergiu, nunca o
 * texto da obra) quando: não há licença no cabeçalho, a licença não contém o trecho esperado, ou o conjunto de
 * tradutores difere do esperado.
 */
export function exigirTraducaoTei(xml: string, exigencia: ExigenciaTei): CabecalhoTei {
  const cabecalho = lerCabecalhoTei(xml);
  if (!cabecalho.licenca) throw new ErroLicenca("cabeçalho sem licença (elemento licence)");
  if (!cabecalho.licenca.toLowerCase().includes(exigencia.licenca.toLowerCase()))
    throw new ErroLicenca(
      `licença do cabeçalho não é a esperada (esperado "${exigencia.licenca}", lido "${cabecalho.licenca}")`,
    );
  const esperados = [...exigencia.tradutores].sort();
  const iguais =
    cabecalho.tradutores.length === esperados.length &&
    cabecalho.tradutores.every((t, i) => t === esperados[i]);
  if (!iguais)
    throw new ErroLicenca(
      `tradutor do cabeçalho não é o esperado (esperado ${JSON.stringify(esperados)}, lido ${JSON.stringify(cabecalho.tradutores)})`,
    );
  return cabecalho;
}
