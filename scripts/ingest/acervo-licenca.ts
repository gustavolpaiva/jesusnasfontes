// Licença e tradutor lidos NO PRÓPRIO ARQUIVO DE ORIGEM, nunca confiados ao registro (D-06).
//
//   TEI (Perseus)   lê-se só o cabeçalho TEI. O "CC BY-SA" do Perseus é licença da EDIÇÃO DIGITAL: não prova que a
//                   tradução é de domínio público (caso Luciano `perseus-eng2`, Harmon 1936). Por isso o registro
//                   lista os tradutores esperados e a leitura reprova qualquer divergência. O corpo nem é
//                   interpretado aqui.
//   Gutenberg       lê-se as DUAS BORDAS do arquivo (antes do marcador de início, depois do marcador de fim): é onde
//                   o Project Gutenberg declara de que edição o texto veio. Arquivo sem declaração em nenhuma das
//                   bordas (Suetônio #6400) NÃO tem licença provada na origem, por mais antigo que seja.
//   HTML            lê-se o texto visível da página: a dedicação ao domínio público feita pelo próprio tradutor
//                   (Mattison, D-24).

import { Parser } from "htmlparser2";
import { type PartesGutenberg, separarGutenberg } from "./acervo-parse-gutenberg";
import { lerParagrafosHtml } from "./acervo-parse-html";

/**
 * `sem_declaracao`: o arquivo não traz declaração de licença onde ela deveria estar. Não é "aviso": a licença
 * ficou sem prova na origem. O `acervo:verify` usa o código para relatar a origem já barrada por esse motivo sem
 * a contar como defeito novo; qualquer OUTRO erro de licença num bruto reprova, publicável ou não.
 * `sem_marcas`: o arquivo nem tem as marcas que delimitam as bordas do Gutenberg.
 */
export type CodigoErroLicenca = "sem_declaracao" | "sem_marcas";

export class ErroLicenca extends Error {
  readonly codigo: CodigoErroLicenca | undefined;
  constructor(mensagem: string, codigo?: CodigoErroLicenca) {
    super(mensagem);
    this.name = "ErroLicenca";
    this.codigo = codigo;
  }
}

export type ExigenciaTei = {
  /** Todos os tradutores esperados; o cabeçalho tem de trazer exatamente este conjunto. */
  tradutores: readonly string[];
  /** Trecho que o texto da licença do cabeçalho tem de conter (sem distinguir maiúsculas). */
  licenca: string;
};

/** O que o próprio arquivo declarou, em qualquer formato. `avisoEditorial` é o aviso da edição sobre o próprio texto. */
export type CabecalhoLido = {
  tradutores: string[];
  licenca: string;
  licencaUrl: string | null;
  anos: string[];
  /** Texto do `editorialDecl` do cabeçalho (vazio se não houver): o aviso da própria edição digital. */
  avisoEditorial: string;
};
export type CabecalhoTei = CabecalhoLido;

/** Gutenberg: além do comum, em qual das bordas a declaração foi lida. */
export type CabecalhoGutenberg = CabecalhoLido & { borda: "inicio" | "fim" };
export type CabecalhoHtml = CabecalhoLido;

// ───────────────────────── ThML (CCEL) ─────────────────────────
// A licença mora no cabeçalho do próprio arquivo: `<DC.Rights>Public Domain</DC.Rights>`, lido SÓ no primeiro
// `ThML.head` do volume (o do documento), dentro dos primeiros 20.000 caracteres. A captura fecha no
// `</ThML.head>` desse cabeçalho (ou ao abrir o corpo): qualquer `ThML.head` posterior, de uma obra interna
// do volume, é ignorado, mesmo que traga DC.Rights e criador esperados. O CCEL não versiona o arquivo: o que
// o fixa é o sha256 do lock do bruto, e mudança de hash é revisão humana.

export type CabecalhoThml = CabecalhoLido & {
  /** Editora lida no DC.Publisher. */
  editora: string;
  /**
   * Cada nome do DC.Creator com o papel que o cabeçalho lhe dá (`sub="Editor"`, `"Author"`, `"Translator"`…); papel
   * ausente fica vazio. Ficam de fora os identificadores do próprio CCEL (`scheme="ccel"`, ex. "schaff"): não são nomes.
   * Nos volumes ANF/NPNF o Schaff aparece como Editor: o cabeçalho do volume NÃO diz quem traduziu cada obra.
   */
  papeis: { nome: string; papel: string }[];
};

/** O que o registro espera do cabeçalho ThML: licença, editores do volume e (só se o cabeçalho os declara) tradutores. */
export type ExigenciaThml = {
  licenca: string;
  /** Nomes que têm de estar entre os DC.Creator: o editor (ou responsável) do volume. */
  editores: readonly string[];
  /** Tradutores que o cabeçalho tem de marcar com o papel Translator (vazio na maioria dos volumes). */
  tradutores?: readonly string[];
};

/** Janela onde o DC.Rights tem de estar: o cabeçalho principal do volume. */
export const JANELA_CABECALHO_THML = 20_000;

/** Lê DC.Rights, DC.Publisher, os DC.Creator e os DC.Date do cabeçalho ThML. Não valida: só lê. */
export function lerCabecalhoThml(xml: string): CabecalhoThml {
  const janela = xml.slice(0, JANELA_CABECALHO_THML);
  let direitos = "";
  let editora = "";
  const criadores = new Set<string>();
  const papeis: { nome: string; papel: string }[] = [];
  let papelAtual = "";
  const anos: string[] = [];
  let capturando: "direitos" | "editora" | "criador" | "ano" | null = null;
  let texto = "";
  let esquemaAtual = "";
  // 0 = ainda não abriu o cabeçalho do documento; 1 = dentro dele; 2 = fechado (nada mais é lido).
  let cabecalho: 0 | 1 | 2 = 0;

  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        if (nome === "ThML.head") {
          if (cabecalho === 0) cabecalho = 1;
          return;
        }
        if (nome === "ThML.body") {
          cabecalho = 2;
          capturando = null;
          return;
        }
        if (cabecalho !== 1) return;
        if (nome === "DC.Rights") {
          capturando = "direitos";
          texto = "";
        } else if (nome === "DC.Publisher") {
          capturando = "editora";
          texto = "";
        } else if (nome === "DC.Creator") {
          capturando = "criador";
          texto = "";
          papelAtual = compactar(atributos.sub ?? "");
          esquemaAtual = atributos.scheme ?? "";
        } else if (nome === "DC.Date") {
          capturando = "ano";
          texto = "";
        }
      },
      ontext(dados) {
        if (capturando && cabecalho === 1) texto += dados;
      },
      onclosetag(nome) {
        if (nome === "ThML.head" && cabecalho === 1) {
          cabecalho = 2;
          capturando = null;
          return;
        }
        if (cabecalho !== 1) return;
        const t = compactar(texto);
        if (capturando === "direitos" && nome === "DC.Rights") {
          if (!direitos && t) direitos = t;
          capturando = null;
        } else if (capturando === "editora" && nome === "DC.Publisher") {
          if (!editora && t) editora = t;
          capturando = null;
        } else if (capturando === "criador" && nome === "DC.Creator") {
          if (t) {
            criadores.add(t);
            if (
              esquemaAtual !== "ccel" &&
              !papeis.some((p) => p.nome === t && p.papel === papelAtual)
            )
              papeis.push({ nome: t, papel: papelAtual });
          }
          capturando = null;
        } else if (capturando === "ano" && nome === "DC.Date") {
          if (t) anos.push(t);
          capturando = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(janela);
  parser.end();

  return {
    tradutores: [...criadores].sort(),
    licenca: direitos,
    licencaUrl: null,
    anos,
    avisoEditorial: "",
    editora,
    papeis,
  };
}

/**
 * Confere o cabeçalho ThML contra o que o registro espera: o DC.Rights tem de existir e ser EXATAMENTE o
 * esperado ("Public Domain"; outro valor reprova citando o lido), e cada EDITOR registrado tem de estar entre
 * os DC.Creator (o editor Schaff nos volumes ANF/NPNF; Lightfoot na coleção dele). O editor NUNCA prova quem
 * traduziu: tradutor só entra aqui se o cabeçalho o marca como Translator (NPNF2-01, McGiffert). Sem DC.Rights, a licença
 * não está provada na origem (`ErroLicenca` com o código `sem_declaracao`), nunca é "aviso".
 */
export function exigirLicencaThml(xml: string, exigencia: ExigenciaThml): CabecalhoThml {
  const cabecalho = lerCabecalhoThml(xml);
  if (!cabecalho.licenca)
    throw new ErroLicenca(
      `licença não provada na origem: cabeçalho ThML sem DC.Rights nos primeiros ${JANELA_CABECALHO_THML} caracteres`,
      "sem_declaracao",
    );
  if (normalizar(cabecalho.licenca) !== normalizar(exigencia.licenca))
    throw new ErroLicenca(
      `DC.Rights do cabeçalho não é o esperado (esperado "${exigencia.licenca}", lido "${cabecalho.licenca}")`,
    );
  const lidos = cabecalho.tradutores.map(normalizar);
  const faltam = exigencia.editores.filter((e) => !lidos.includes(normalizar(e)));
  if (faltam.length > 0)
    throw new ErroLicenca(
      `nome esperado ausente no DC do cabeçalho (esperado ${JSON.stringify([...exigencia.editores].sort())}, não achado ${JSON.stringify(faltam)})`,
    );
  // O editor registrado não pode constar no cabeçalho como tradutor: seria o registro dizendo "editor" do que o
  // arquivo diz "tradutor" (o caso de McGiffert no NPNF). Tradutor registrado tem de ter o papel Translator.
  const comPapel = (nome: string, papel: string) =>
    cabecalho.papeis.some(
      (p) => normalizar(p.nome) === normalizar(nome) && normalizar(p.papel) === papel,
    );
  const editorQueTraduz = exigencia.editores.filter((e) => comPapel(e, "translator"));
  if (editorQueTraduz.length > 0)
    throw new ErroLicenca(
      `registrado como editor, mas o cabeçalho o marca como Translator: ${JSON.stringify(editorQueTraduz)}`,
    );
  const semPapel = (exigencia.tradutores ?? []).filter((t) => !comPapel(t, "translator"));
  if (semPapel.length > 0)
    throw new ErroLicenca(
      `tradutor registrado sem o papel Translator no DC do cabeçalho: ${JSON.stringify(semPapel)}`,
    );
  return cabecalho;
}

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
/** Para conferir uma frase: espaços e quebras de linha fechados, sem distinguir maiúsculas. */
const normalizar = (s: string) => compactar(s).toLowerCase();

/** Lê tradutor(es), licença e ano de edição do cabeçalho TEI. Não valida: só lê. */
export function lerCabecalhoTei(xml: string): CabecalhoTei {
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
  // A estrutura vem dos eventos do parser (comentário, CDATA e instrução de processamento nunca abrem elemento).
  // 0 = ainda não abriu o teiHeader; 1 = dentro do primeiro; 2 = fechado. `textoAntes`: o `<text>` abriu antes
  // de existir cabeçalho, então qualquer teiHeader posterior é de obra interna e não conta.
  let cabecalhoEstado: 0 | 1 | 2 = 0;
  let textoAntes = false;

  const parser: Parser = new Parser(
    {
      onopentag(nome, atributos) {
        if (cabecalhoEstado === 0) {
          if (nome === "teiHeader") cabecalhoEstado = 1;
          else if (nome === "text") {
            textoAntes = true;
            parser.pause();
          }
          return;
        }
        if (cabecalhoEstado !== 1) return;
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
        if (cabecalhoEstado !== 1) return;
        if (capturando) texto += dados;
        if (editorial > 0) paragrafoEditorial += dados;
      },
      onclosetag(nome) {
        if (cabecalhoEstado !== 1) return;
        if (nome === "teiHeader") {
          cabecalhoEstado = 2;
          parser.pause();
          return;
        }
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
  parser.write(xml); // pára (pause) ao fechar o cabeçalho ou ao abrir o texto: o corpo nunca é lido

  if (textoAntes) throw new ErroLicenca("arquivo sem cabeçalho TEI (teiHeader) antes do texto");
  // (o TS não vê as atribuições feitas dentro dos callbacks do parser: o cast evita o estreitamento a `0`)
  if ((cabecalhoEstado as number) !== 2)
    throw new ErroLicenca("arquivo sem cabeçalho TEI (teiHeader)");

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

// ───────────────────────── Gutenberg e HTML ─────────────────────────

export type ExigenciaGutenberg = {
  /** Todos os tradutores esperados; cada nome tem de aparecer no próprio arquivo (cabeçalho ou página de rosto). */
  tradutores: readonly string[];
  /** Declaração que uma das bordas do arquivo tem de conter, sem distinguir maiúsculas e com espaços fechados. */
  licenca: string;
};
export type ExigenciaDedicacao = ExigenciaGutenberg;

/**
 * Ache a frase esperada no texto já lido e devolva-a como o arquivo a imprime. `compacto` e `minimo` são o mesmo
 * texto, um na caixa original e outro em minúsculas. Se o trecho esperado já é uma frase inteira (termina em ponto),
 * devolve só ele; se não, estende até o ponto que fecha a frase no arquivo.
 */
function fraseLida(compacto: string, minimo: string, esperado: string): string | null {
  const i = minimo.indexOf(esperado);
  if (i < 0) return null;
  const fonte = compacto.length === minimo.length ? compacto : minimo;
  const fimDoTrecho = i + esperado.length;
  if (/[.!?]$/.test(esperado)) return fonte.slice(i, fimDoTrecho);
  const ponto = fonte.indexOf(". ", fimDoTrecho);
  return ponto < 0 ? fonte.slice(i) : fonte.slice(i, ponto + 1);
}

/**
 * Confere a licença de um arquivo do Project Gutenberg pelo que o PRÓPRIO ARQUIVO declara nas duas bordas: (a) a
 * declaração de que a obra vem de edição impressa em domínio público e (b) os nomes dos tradutores esperados.
 * Lança `ErroLicenca` com o código `sem_declaracao` quando nenhuma das bordas traz a declaração: a licença não
 * está provada na origem (nunca é "aviso"). Declaração escrita no corpo, entre os marcadores, não conta.
 */
export function exigirLicencaGutenberg(
  texto: string,
  exigencia: ExigenciaGutenberg,
): CabecalhoGutenberg {
  let partes: PartesGutenberg;
  try {
    partes = separarGutenberg(texto);
  } catch (erro) {
    throw new ErroLicenca(
      `licença não provada na origem: ${(erro as Error).message}`,
      "sem_marcas",
    );
  }
  const esperado = normalizar(exigencia.licenca);
  let borda: "inicio" | "fim" | null = null;
  let licenca = "";
  for (const [nome, conteudo] of [
    ["inicio", partes.inicio],
    ["fim", partes.fim],
  ] as const) {
    const achado = fraseLida(compactar(conteudo), normalizar(conteudo), esperado);
    if (achado !== null) {
      borda = nome;
      licenca = achado;
      break;
    }
  }
  if (borda === null)
    throw new ErroLicenca(
      `licença não provada na origem: nenhuma das bordas do arquivo declara "${exigencia.licenca}"`,
      "sem_declaracao",
    );

  const lido = normalizar(`${partes.inicio}\n${partes.corpo}`);
  const faltam = exigencia.tradutores.filter((t) => !lido.includes(normalizar(t)));
  if (faltam.length > 0)
    throw new ErroLicenca(
      `tradutor esperado não aparece no arquivo (esperado ${JSON.stringify(exigencia.tradutores)}, não achado ${JSON.stringify(faltam)})`,
    );
  return {
    tradutores: [...exigencia.tradutores].sort(),
    licenca,
    licencaUrl: null,
    anos: [],
    avisoEditorial: "",
    borda,
  };
}

/**
 * Confere, pelo texto VISÍVEL da página, a dedicação ao domínio público feita pelo próprio tradutor e o nome
 * dele. Página sem a frase lança `ErroLicenca` com o código `sem_declaracao`. Frase que só existe dentro de
 * `script` ou `style` não conta.
 */
export function exigirDedicacaoDominioPublico(
  html: string,
  exigencia: ExigenciaDedicacao,
): CabecalhoHtml {
  const texto = lerParagrafosHtml(html).texto;
  const achado = fraseLida(texto, normalizar(texto), normalizar(exigencia.licenca));
  if (achado === null)
    throw new ErroLicenca(
      `licença não provada na origem: a página não traz a dedicação "${exigencia.licenca}"`,
      "sem_declaracao",
    );
  const lido = normalizar(texto);
  const faltam = exigencia.tradutores.filter((t) => !lido.includes(normalizar(t)));
  if (faltam.length > 0)
    throw new ErroLicenca(
      `tradutor esperado não aparece na página (esperado ${JSON.stringify(exigencia.tradutores)}, não achado ${JSON.stringify(faltam)})`,
    );
  return {
    tradutores: [...exigencia.tradutores].sort(),
    licenca: achado,
    licencaUrl: null,
    anos: [],
    avisoEditorial: "",
  };
}
