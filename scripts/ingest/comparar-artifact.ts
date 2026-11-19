// pnpm exec tsx scripts/ingest/comparar-artifact.ts --artifact <evangelhos.json> [--resumo <arquivo>] [--banco]
//
// Mede a completude das duas edições da Bíblia Livre contra o esperado e compara, versículo a
// versículo, os quatro evangelhos e 1 Coríntios 15 com o evangelhos.json do protótipo. O arquivo do
// protótipo é só lido (nunca copiado para o produto). Grava data/relatorios/biblia-livre-completude.md
// (determinístico: sem data nem caminho local). Com --banco, confere também o que está no banco
// (como jnf_app) contra o que foi interpretado, edição por edição e livro por livro.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { sanitizarErroDeBanco } from "../../src/db/erro-banco";
import { urlDoPapel } from "../../src/db/url";
import { registrarErro } from "../../src/lib/registro";
import { decompor } from "../../src/modules/referencias/chave";
import { LIVROS } from "../../src/modules/referencias/livros";
import { ErroCarga, lerEdicoesVerificadas, textoIdDe } from "./carregar-biblia";
import { type Edicao, RAIZ_PRODUTO } from "./fontes";

const CAMINHO_RELATORIO = path.join(RAIZ_PRODUTO, "data/relatorios/biblia-livre-completude.md");

// Livros do artifact: chave do JSON, número do livro e abreviação do relatório.
const LIVROS_DO_ARTIFACT = [
  { chave: "mt", livro: 40, abreviacao: "Mt" },
  { chave: "mc", livro: 41, abreviacao: "Mc" },
  { chave: "lc", livro: 42, abreviacao: "Lc" },
  { chave: "jo", livro: 43, abreviacao: "Jo" },
  { chave: "1co", livro: 46, abreviacao: "1Co" },
] as const;

export const CLASSES = ["so-n4", "so-tr", "quase", "mesclado", "variante", "redacao"] as const;
export type ClasseDeDiferenca = (typeof CLASSES)[number];

const EXPLICACAO: Record<ClasseDeDiferenca, string> = {
  "so-n4":
    "as duas edições diferem entre si neste versículo (variante textual) e o artifact segue a n4",
  "so-tr":
    "as duas edições diferem entre si neste versículo (variante textual) e o artifact segue a tr",
  quase:
    "só pontuação, maiúscula ou aspas separam o artifact de pelo menos uma edição (as palavras são as mesmas)",
  mesclado:
    "Mc 5:18 e 5:19: a Bíblia Livre traz o texto dos dois no id de 5:18 (o par é comparado inteiro com 5:18); o artifact os separa",
  variante:
    "as duas edições diferem entre si e nenhuma coincide com o artifact (variante textual somada à redação)",
  redacao:
    "as duas edições trazem o mesmo texto e o artifact usa outra redação em português para o mesmo versículo",
};

// ───────────────────────── normalização ─────────────────────────

export function normalizar(texto: string): string {
  return texto.normalize("NFC").replace(/[«»]/g, "").replace(/\s+/g, " ").trim();
}

// Só as palavras: minúsculas, sem pontuação nem aspas. Acento é mantido.
export function palavras(texto: string): string[] {
  return normalizar(texto)
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((p) => p !== "");
}

export function similaridade(a: string, b: string): number {
  const A = new Set(palavras(a));
  const B = new Set(palavras(b));
  if (A.size === 0 && B.size === 0) return 1;
  let comum = 0;
  for (const p of A) if (B.has(p)) comum++;
  return comum / (A.size + B.size - comum);
}

export function classificar(
  artifact: string,
  n4: string,
  tr: string,
  mesclado: boolean,
): ClasseDeDiferenca | "ambas" {
  const a = normalizar(artifact);
  const bateN4 = a === normalizar(n4);
  const bateTr = a === normalizar(tr);
  if (bateN4 && bateTr) return "ambas";
  if (bateN4) return "so-n4";
  if (bateTr) return "so-tr";
  if (mesclado) return "mesclado";
  const frase = palavras(artifact).join(" ");
  if (frase === palavras(n4).join(" ") || frase === palavras(tr).join(" ")) return "quase";
  if (normalizar(n4) !== normalizar(tr)) return "variante";
  return "redacao";
}

// ───────────────────────── referências para o relatório ─────────────────────────

const ABREVIACAO = (livro: number) => LIVROS[livro - 1]?.abreviacoes[0] ?? String(livro);

/** Chaves ordenadas viram "Mt 1:2-4, 7; Mt 2:1" (faixas contíguas, um capítulo por vez). */
export function referenciasCompactas(chaves: readonly number[]): string {
  const ordenadas = [...chaves].sort((a, b) => a - b);
  const grupos: { livro: number; capitulo: number; faixas: [number, number][] }[] = [];
  for (const k of ordenadas) {
    const p = decompor(k);
    let g = grupos.at(-1);
    if (!g || g.livro !== p.livro || g.capitulo !== p.capitulo) {
      g = { livro: p.livro, capitulo: p.capitulo, faixas: [] };
      grupos.push(g);
    }
    const ultima = g.faixas.at(-1);
    if (ultima && ultima[1] + 1 === p.versiculo) ultima[1] = p.versiculo;
    else g.faixas.push([p.versiculo, p.versiculo]);
  }
  return grupos
    .map(
      (g) =>
        `${ABREVIACAO(g.livro)} ${g.capitulo}:${g.faixas
          .map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
          .join(", ")}`,
    )
    .join("; ");
}

// ───────────────────────── medição ─────────────────────────

type Artifact = Record<string, Record<string, string[]>>;

export type LinhaDeLivro = {
  livro: number;
  nome: string;
  esperado: number;
  lidos: Record<Edicao, number>;
};

export type ComparacaoLivro = {
  abreviacao: string;
  livro: number;
  artifact: number;
  unidades: number;
  exatos: Record<Edicao, number>;
  ambas: number;
};

export type Medicao = {
  commit: string;
  impressao: string;
  esperadoTotal: number;
  esperadoCapitulos: number;
  excecoes: { referencia: string; dentroDe: string }[];
  semTexto: { referencia: string; edicao: Edicao }[];
  porLivro: LinhaDeLivro[];
  totais: Record<Edicao, { versiculos: number; capitulos: number }>;
  comparacao: ComparacaoLivro[];
  artifactTotal: number;
  artifactEvangelhos: number;
  unidadesComparadas: number;
  exatosTotal: Record<Edicao, number>;
  ambasTotal: number;
  classes: Record<ClasseDeDiferenca, number>;
  listas: Record<ClasseDeDiferenca, number[]>;
  similaridadeMedia: Record<Edicao, number>;
  maisProximo: { n4: number; tr: number; empate: number };
  contagens: Record<Edicao, Map<number, number>>;
  artifactSha256: string;
};

const capitulosDe = (vs: readonly { chave: number }[]): number =>
  new Set(vs.map((v) => Math.floor(v.chave / 1000))).size;

export async function medir(artifactBytes: Uint8Array): Promise<Medicao> {
  const artifact = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes),
  ) as Artifact;
  const leitura = await lerEdicoesVerificadas();
  const esperado = leitura.registro.esperado;
  if (!esperado) throw new ErroCarga("datasets.yaml sem esperado");
  const n4 = leitura.edicoes.find((e) => e.edicao === "n4");
  const tr = leitura.edicoes.find((e) => e.edicao === "tr");
  if (!n4 || !tr) throw new ErroCarga("falta uma das edições");

  const contagens: Record<Edicao, Map<number, number>> = { n4: new Map(), tr: new Map() };
  const textoPorChave: Record<Edicao, Map<number, string>> = { n4: new Map(), tr: new Map() };
  for (const e of [n4, tr]) {
    for (const v of e.versiculos) {
      const l = decompor(v.chave).livro;
      contagens[e.edicao].set(l, (contagens[e.edicao].get(l) ?? 0) + 1);
      textoPorChave[e.edicao].set(v.chave, v.texto);
    }
  }

  const porLivro: LinhaDeLivro[] = LIVROS.map((l) => {
    const soma = l.ultimoVersiculo.reduce((s, x) => s + x, 0);
    const mesclados = n4.mesclados.filter((m) => decompor(m.chave).livro === l.numero).length;
    return {
      livro: l.numero,
      nome: l.nome,
      esperado: soma - mesclados,
      lidos: { n4: contagens.n4.get(l.numero) ?? 0, tr: contagens.tr.get(l.numero) ?? 0 },
    };
  });
  const somaEsperada = porLivro.reduce((s, l) => s + l.esperado, 0);
  if (somaEsperada !== esperado.versiculos)
    throw new ErroCarga(
      `o esperado por livro soma ${somaEsperada}, o registro diz ${esperado.versiculos}`,
    );

  // Carregador do par mesclado: chave que carrega o texto -> chave do versículo mesclado.
  const carregaMesclado = new Map<number, number>();
  for (const m of n4.mesclados) {
    const obs = /^texto dentro de ([A-Za-z0-9]+)\.(\d+)\.(\d+)$/.exec(m.observacao);
    if (!obs) throw new ErroCarga(`observação de mesclado inesperada: ${m.observacao}`);
    const livro = decompor(m.chave).livro;
    carregaMesclado.set(livro * 1_000_000 + Number(obs[2]) * 1_000 + Number(obs[3]), m.chave);
  }
  const mescladas = new Set(carregaMesclado.values());

  const versos: { chave: number; texto: string }[] = [];
  for (const l of LIVROS_DO_ARTIFACT) {
    const capitulos = artifact[l.chave];
    if (!capitulos) throw new ErroCarga(`o artifact não tem o livro ${l.chave}`);
    for (const cap of Object.keys(capitulos).sort((x, y) => Number(x) - Number(y))) {
      (capitulos[cap] as string[]).forEach((texto, i) => {
        versos.push({ chave: l.livro * 1_000_000 + Number(cap) * 1_000 + (i + 1), texto });
      });
    }
  }
  const textoDoArtifact = new Map(versos.map((v) => [v.chave, v.texto]));

  const classes = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<
    ClasseDeDiferenca,
    number
  >;
  const listas = Object.fromEntries(CLASSES.map((c) => [c, [] as number[]])) as Record<
    ClasseDeDiferenca,
    number[]
  >;
  const comp = new Map<number, ComparacaoLivro>(
    LIVROS_DO_ARTIFACT.map((l) => [
      l.livro,
      {
        abreviacao: l.abreviacao,
        livro: l.livro,
        artifact: 0,
        unidades: 0,
        exatos: { n4: 0, tr: 0 },
        ambas: 0,
      },
    ]),
  );
  const exatosTotal = { n4: 0, tr: 0 };
  const soma = { n4: 0, tr: 0 };
  const proximo = { n4: 0, tr: 0, empate: 0 };
  let ambasTotal = 0;
  let unidades = 0;

  for (const v of versos) {
    const c = comp.get(decompor(v.chave).livro) as ComparacaoLivro;
    c.artifact++;
    // O versículo mesclado (5:19) é comparado junto com o que carrega o texto (5:18), uma vez só.
    if (mescladas.has(v.chave)) continue;
    const parceiro = carregaMesclado.get(v.chave);
    const textoArtifact =
      parceiro === undefined ? v.texto : `${v.texto} ${textoDoArtifact.get(parceiro) ?? ""}`;
    const tN4 = textoPorChave.n4.get(v.chave);
    const tTr = textoPorChave.tr.get(v.chave);
    if (tN4 === undefined || tTr === undefined)
      throw new ErroCarga(`o artifact tem um versículo que a Bíblia Livre não tem: ${v.chave}`);
    c.unidades++;
    unidades++;
    const bateN4 = normalizar(textoArtifact) === normalizar(tN4);
    const bateTr = normalizar(textoArtifact) === normalizar(tTr);
    if (bateN4) {
      c.exatos.n4++;
      exatosTotal.n4++;
    }
    if (bateTr) {
      c.exatos.tr++;
      exatosTotal.tr++;
    }
    const classe = classificar(textoArtifact, tN4, tTr, parceiro !== undefined);
    if (classe === "ambas") {
      c.ambas++;
      ambasTotal++;
    } else {
      classes[classe]++;
      listas[classe].push(v.chave);
      if (parceiro !== undefined) listas[classe].push(parceiro);
    }
    const sN4 = similaridade(textoArtifact, tN4);
    const sTr = similaridade(textoArtifact, tTr);
    soma.n4 += sN4;
    soma.tr += sTr;
    if (sN4 > sTr) proximo.n4++;
    else if (sTr > sN4) proximo.tr++;
    else proximo.empate++;
  }

  return {
    commit: leitura.registro.commit,
    impressao: leitura.impressao,
    esperadoTotal: esperado.versiculos,
    esperadoCapitulos: esperado.capitulos,
    excecoes: esperado.excecoes.map((e) => ({ referencia: e.referencia, dentroDe: e.dentro_de })),
    semTexto: (esperado.sem_texto ?? []).map((s) => ({
      referencia: s.referencia,
      edicao: s.edicao,
    })),
    porLivro,
    totais: {
      n4: { versiculos: n4.versiculos.length, capitulos: capitulosDe(n4.versiculos) },
      tr: { versiculos: tr.versiculos.length, capitulos: capitulosDe(tr.versiculos) },
    },
    comparacao: [...comp.values()],
    artifactTotal: versos.length,
    artifactEvangelhos: versos.filter((v) => decompor(v.chave).livro <= 43).length,
    unidadesComparadas: unidades,
    exatosTotal,
    ambasTotal,
    classes,
    listas,
    similaridadeMedia: { n4: soma.n4 / unidades, tr: soma.tr / unidades },
    maisProximo: proximo,
    contagens,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  };
}

// ───────────────────────── relatório ─────────────────────────

const pct = (parte: number, todo: number): string =>
  `${((100 * parte) / todo).toFixed(1).replace(".", ",")}%`;

export function renderizarRelatorio(m: Medicao): string {
  const L: string[] = [];
  const ev = m.comparacao.filter((c) => c.livro <= 43);
  const co = m.comparacao.filter((c) => c.livro > 43);
  const soma = (xs: ComparacaoLivro[], f: (c: ComparacaoLivro) => number) =>
    xs.reduce((s, c) => s + f(c), 0);

  L.push("# Bíblia Livre: completude e comparação com o texto do protótipo", "");
  L.push(
    "Relatório gerado por `scripts/ingest/comparar-artifact.ts`. Não tem data nem caminho local: rodar de novo sobre os mesmos arquivos dá o mesmo texto.",
    "",
  );
  L.push("## Fonte", "");
  L.push(
    `- Bíblia Livre (BLIVRE), commit \`${m.commit}\`, edições n4 (Novo Testamento pelo texto crítico de Nestle 1904) e tr (Textus Receptus).`,
  );
  L.push(
    `- Impressão do que foi interpretado (as duas edições): \`${m.impressao}\`. É a mesma que \`pnpm ingest:verify --impressao\` imprime.`,
  );
  L.push(`- Arquivo do protótipo lido: evangelhos.json, sha256 \`${m.artifactSha256}\`.`, "");

  L.push("## Completude contra o esperado", "");
  L.push(
    `Esperado de cada edição: ${m.esperadoTotal} versículos (31101 ids), ${m.esperadoCapitulos} capítulos e 66 livros. O esperado por livro é a soma do último versículo de cada capítulo, menos os versículos mesclados nomeados abaixo.`,
    "",
  );
  L.push("| Edição | Versículos lidos | Esperado | Capítulos lidos | Esperado | Situação |");
  L.push("|---|---|---|---|---|---|");
  for (const e of ["n4", "tr"] as const) {
    const t = m.totais[e];
    const ok = t.versiculos === m.esperadoTotal && t.capitulos === m.esperadoCapitulos;
    L.push(
      `| ${e} | ${t.versiculos} | ${m.esperadoTotal} | ${t.capitulos} | ${m.esperadoCapitulos} | ${ok ? "completa" : "DIFERE"} |`,
    );
  }
  L.push("", "Exceções nomeadas (qualquer outra falta reprova a verificação):", "");
  for (const e of m.excecoes) {
    L.push(
      `- ${e.referencia} não tem id próprio nas duas edições: o texto está dentro de ${e.dentroDe}. A chave do versículo existe no banco e a correspondência de versificação a liga ao marcador do arquivo-fonte, sem linha de texto. Por isso cada edição tem ${m.esperadoTotal} linhas de texto e o banco tem ${m.esperadoTotal + m.excecoes.length} chaves de versículo.`,
    );
  }
  for (const s of m.semTexto) {
    L.push(
      `- ${s.referencia} na edição ${s.edicao}: o arquivo-fonte traz o id e nenhum texto (só uma nota). A linha existe, vazia, e conta nos ${m.esperadoTotal}.`,
    );
  }
  L.push("", "### Por livro", "", "| Livro | Esperado | n4 | tr |", "|---|---|---|---|");
  for (const l of m.porLivro) {
    L.push(`| ${l.nome} | ${l.esperado} | ${l.lidos.n4} | ${l.lidos.tr} |`);
  }
  const dif = m.porLivro.filter((l) => l.lidos.n4 !== l.esperado || l.lidos.tr !== l.esperado);
  L.push(
    "",
    dif.length === 0
      ? "Nenhum livro difere do esperado, em nenhuma das duas edições."
      : `Livros que diferem do esperado: ${dif.map((l) => l.nome).join(", ")}.`,
    "",
  );

  L.push("## Comparação com o texto do protótipo (evangelhos.json)", "");
  L.push(
    `O protótipo tem ${m.artifactEvangelhos} versículos nos quatro evangelhos e ${soma(co, (c) => c.artifact)} em 1 Coríntios 15; a Bíblia Livre tem 3778 ids nos evangelhos. A diferença de um é Marcos 5:19, que o protótipo separa e a Bíblia Livre traz dentro de 5:18: esse par é comparado inteiro com 5:18, uma vez.`,
    "",
  );
  L.push(
    "Comparação exata: o texto do protótipo e o da edição são iguais depois de normalizar (NFC, espaços repetidos viram um, sem « », sem marcas de nota). Nada além disso é relevado.",
    "",
  );
  L.push(
    "| Livro | Versículos no protótipo | Comparados | Batem com n4 | Batem com tr | Batem com as duas |",
  );
  L.push("|---|---|---|---|---|---|");
  for (const c of m.comparacao) {
    L.push(
      `| ${c.abreviacao} | ${c.artifact} | ${c.unidades} | ${c.exatos.n4} | ${c.exatos.tr} | ${c.ambas} |`,
    );
  }
  L.push(
    `| Quatro evangelhos | ${soma(ev, (c) => c.artifact)} | ${soma(ev, (c) => c.unidades)} | ${soma(ev, (c) => c.exatos.n4)} | ${soma(ev, (c) => c.exatos.tr)} | ${soma(ev, (c) => c.ambas)} |`,
  );
  L.push(
    `| Todos | ${m.artifactTotal} | ${m.unidadesComparadas} | ${m.exatosTotal.n4} | ${m.exatosTotal.tr} | ${m.ambasTotal} |`,
    "",
  );
  L.push(
    `Em ${pct(m.exatosTotal.n4, m.unidadesComparadas)} dos versículos comparados o protótipo é igual à n4 e em ${pct(m.exatosTotal.tr, m.unidadesComparadas)} é igual à tr.`,
    `Pela sobreposição de palavras (acentos mantidos, sem pontuação nem maiúsculas) o protótipo está em média a ${pct(m.similaridadeMedia.n4, 1)} da n4 e a ${pct(m.similaridadeMedia.tr, 1)} da tr; a n4 é a mais próxima em ${m.maisProximo.n4} versículos, a tr em ${m.maisProximo.tr} e há empate em ${m.maisProximo.empate}.`,
    "",
  );

  L.push("### Cada versículo que difere de alguma edição, com a explicação", "");
  L.push(
    `Fora das listas ficam só os ${m.ambasTotal} versículos que batem exatamente com as duas edições. Cada versículo aparece em uma lista só.`,
    "",
  );
  for (const classe of CLASSES) {
    L.push(`#### ${classe}: ${m.classes[classe]} versículo(s)`, "", EXPLICACAO[classe], "");
    L.push(m.listas[classe].length === 0 ? "Nenhum." : referenciasCompactas(m.listas[classe]), "");
  }

  L.push("## Recomendação de edição (decisão do dono)", "");
  const maisTr = m.exatosTotal.tr > m.exatosTotal.n4;
  L.push(
    `Números: exatos n4 ${m.exatosTotal.n4} de ${m.unidadesComparadas}, exatos tr ${m.exatosTotal.tr} de ${m.unidadesComparadas}.`,
  );
  L.push(
    maisTr
      ? "O protótipo casa mais com a tr do que com a n4. É o caso em que a pesquisa manda pesar a tr: o grupo leu esse texto. Em contrapartida, a n4 conversa com o grego crítico que o projeto pretende juntar depois e marca os trechos duvidosos com « »."
      : "A n4 casa pelo menos tanto quanto a tr com o texto que o protótipo já usava, conversa com o grego crítico que o projeto pretende juntar depois e marca os trechos duvidosos com « ». Recomendação da pesquisa mantida: n4.",
  );
  L.push(
    "A tr não tem o texto de At 28:29 no arquivo-fonte (só uma nota); a n4 traz o versículo marcado com « ». A escolha é do dono; trocar depois é mudar um campo.",
    "",
  );
  return `${L.join("\n")}\n`;
}

// ───────────────────────── conferência no banco ─────────────────────────

export async function conferirNoBanco(
  m: Medicao,
): Promise<{ linhas: string[]; divergencias: string[] }> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: true }) });
  const linhas: string[] = [];
  const divergencias: string[] = [];
  try {
    await cliente.connect();
    for (const e of ["n4", "tr"] as const) {
      const r = await cliente.query<{ livro: number; n: number }>(
        `select v.livro::int as livro, count(*)::int as n
         from acervo.texto_versiculo tv join acervo.versiculo v on v.id = tv.versiculo_id
         where tv.texto_id = $1 group by v.livro order by v.livro`,
        [textoIdDe(e)],
      );
      const noBanco = new Map(r.rows.map((x) => [x.livro, x.n]));
      let total = 0;
      for (const l of m.porLivro) {
        const lido = m.contagens[e].get(l.livro) ?? 0;
        const banco = noBanco.get(l.livro) ?? 0;
        total += banco;
        if (banco !== lido || banco !== l.esperado)
          divergencias.push(
            `${e} ${l.nome}: banco ${banco}, interpretado ${lido}, esperado ${l.esperado}`,
          );
      }
      linhas.push(
        `banco edicao=${e} livros=${noBanco.size} versiculos=${total} esperado=${m.esperadoTotal}`,
      );
      if (total !== m.esperadoTotal)
        divergencias.push(`${e}: ${total} no banco, esperado ${m.esperadoTotal}`);
    }
    const chaves = await cliente.query<{ n: number }>(
      "select count(*)::int as n from acervo.versiculo",
    );
    const esperadoChaves = m.esperadoTotal + m.excecoes.length;
    linhas.push(`banco chaves_de_versiculo=${chaves.rows[0]?.n} esperado=${esperadoChaves}`);
    if (chaves.rows[0]?.n !== esperadoChaves)
      divergencias.push("chaves de versículo diferem do esperado");
    const corr = await cliente.query<{ n: number; sem_chave: number }>(
      `select count(*)::int as n, count(*) filter (where versiculo_id is null)::int as sem_chave
       from acervo.correspondencia_versificacao where conjunto_id = 'biblia-livre'`,
    );
    linhas.push(
      `banco correspondencias=${corr.rows[0]?.n} sem_chave=${corr.rows[0]?.sem_chave} esperado=${esperadoChaves}`,
    );
    if (corr.rows[0]?.n !== esperadoChaves || corr.rows[0]?.sem_chave !== 0)
      divergencias.push("correspondências diferem do esperado");
    const conj = await cliente.query<{
      id: string;
      versao: string;
      commit: string;
      edicao_exibida: string | null;
    }>("select id, versao, commit, edicao_exibida from acervo.conjunto_dados");
    for (const c of conj.rows) {
      linhas.push(
        `banco conjunto=${c.id} versao=${c.versao} commit=${c.commit} edicao_exibida=${c.edicao_exibida ?? "nula"}`,
      );
      if (c.commit !== m.commit)
        divergencias.push(`conjunto ${c.id}: commit ${c.commit} difere do fixado`);
    }
    if (conj.rows.length !== 1)
      divergencias.push(`conjunto_dados tem ${conj.rows.length} linhas, esperava 1`);
  } catch (erro) {
    throw erro instanceof ErroCarga ? erro : sanitizarErroDeBanco(erro);
  } finally {
    await cliente.end().catch(() => {});
  }
  return { linhas, divergencias };
}

// ───────────────────────── linha de comando ─────────────────────────

function valorDe(args: string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const artifact = valorDe(args, "--artifact");
  if (!artifact)
    throw new ErroCarga(
      "Uso: comparar-artifact.ts --artifact <evangelhos.json> [--resumo <arquivo>] [--banco]",
    );
  const bytes = new Uint8Array(await readFile(path.resolve(artifact)));
  const m = await medir(bytes);
  const relatorio = renderizarRelatorio(m);
  await mkdir(path.dirname(CAMINHO_RELATORIO), { recursive: true });
  await writeFile(CAMINHO_RELATORIO, relatorio);

  const saida: string[] = [];
  for (const e of ["n4", "tr"] as const) {
    saida.push(
      `edicao=${e} versiculos=${m.totais[e].versiculos} capitulos=${m.totais[e].capitulos} esperado=${m.esperadoTotal}`,
    );
  }
  saida.push(
    `artifact total=${m.artifactTotal} evangelhos=${m.artifactEvangelhos} comparados=${m.unidadesComparadas}`,
    `exatos n4=${m.exatosTotal.n4} tr=${m.exatosTotal.tr} ambas=${m.ambasTotal}`,
    `similaridade_media n4=${m.similaridadeMedia.n4.toFixed(4)} tr=${m.similaridadeMedia.tr.toFixed(4)}`,
    `mais_proximo n4=${m.maisProximo.n4} tr=${m.maisProximo.tr} empate=${m.maisProximo.empate}`,
    `classes ${CLASSES.map((c) => `${c}=${m.classes[c]}`).join(" ")}`,
  );
  let falhou = false;
  if (args.includes("--banco")) {
    const b = await conferirNoBanco(m);
    saida.push(...b.linhas);
    if (b.divergencias.length > 0) {
      falhou = true;
      saida.push(...b.divergencias.map((d) => `DIVERGE ${d}`));
    } else {
      saida.push("banco: contagens iguais às interpretadas, por edição e por livro");
    }
  }
  for (const l of saida) console.log(l);

  const resumo = valorDe(args, "--resumo");
  if (resumo) {
    const texto = [
      "# SP-5: Bíblia Livre, completude e comparação com o protótipo",
      "",
      "Gerado por `scripts/ingest/comparar-artifact.ts` (relatório completo em `data/relatorios/biblia-livre-completude.md` do produto).",
      "",
      "```",
      ...saida,
      "```",
      "",
    ].join("\n");
    await writeFile(path.resolve(resumo), texto);
  }
  if (falhou) throw new ErroCarga("o banco difere do interpretado: veja as linhas DIVERGE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro: unknown) => {
    if (erro instanceof ErroCarga) console.error(erro.message);
    else if (
      erro instanceof Error &&
      ["ErroValidacao", "ErroChecksum", "ErroF4"].includes(erro.name)
    )
      console.error(erro.message);
    else registrarErro("comparar-artifact", erro);
    process.exit(1);
  });
}
