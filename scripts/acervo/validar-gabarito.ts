// `tsx scripts/acervo/validar-gabarito.ts --arquivo <caminho>` — conferência de FORMATO do gabarito do
// Assistente (plano 02-23, início antecipado de ASST-12). O gabarito de verdade NÃO vive no produto (D-21):
// este script é genérico, recebe o arquivo por parâmetro (nunca lê nada por padrão) e confere por máquina que
// cada Fonte e cada referência esperadas existem no Acervo carregado (YAML `publicada: true` + derivado no
// lock). A saída traz SÓ ids, contagens e a regra reprovada — nunca o texto de uma pergunta (T-02-64): TODO
// erro nomeia o campo e a regra violada, jamais um valor do arquivo (nem truncado). A identidade de uma Fonte
// é o slug DECLARADO no seu YAML — o mesmo que a carga usa — e o nome do arquivo e o slug interno do derivado
// têm de confirmá-la; referência só resolve pelo slug declarado. Reprovações: contrato, pergunta-vazia,
// id-repetido, resposta-sem-fonte, sem-resposta-com-fonte, fonte-inexistente, fonte-nao-publicada,
// derivado-ausente, referencia-inexistente, grupo-invalido, categoria-invalida. O resumo compara o arquivo
// com os pisos do RASCUNHO da Fase 2 sem aprovar nem reprovar o conjunto: critério de aprovação e execução são
// do portão da Fase 4, via T3.5 da Fase 3.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as lerYaml } from "yaml";
import { z } from "zod";
import { interpretarFonteYaml } from "../../src/modules/acervo/schemas";
import { PASTA_FONTES } from "./carregar";
import {
  CAMINHO_LOCK,
  lerDerivado,
  lerLock,
  PASTA_DERIVADOS,
  verificarDerivados,
} from "./derivados";

export const GRUPOS = ["aberto", "reservado"] as const;
export const CATEGORIAS = [
  "factual",
  "entre-idiomas",
  "pessoal-ou-de-fe",
  "fora-do-acervo",
  "armadilha",
] as const;

// Pisos do RASCUNHO desta fase (02-23): metade da meta de 80 do T3.5 (ROADMAP), 10 das 20 sem resposta e o piso
// de 40% reservado já valendo. São informação, não reprovação.
export const PISOS_FASE2 = {
  total: 40,
  semResposta: 10,
  reservadoPercentual: 40,
  entreIdiomas: 8,
  pessoalOuDeFe: 5,
} as const;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

const esquemaEntrada = z
  .object({
    id: z.string().regex(SLUG, "id deve ser kebab-case"),
    pergunta: z.string(),
    tem_resposta: z.boolean(),
    fontes_esperadas: z
      .array(z.object({ slug: z.string().regex(SLUG), ref: z.string().min(1) }))
      .default([]),
    grupo: z.string(),
    categoria: z.string(),
    escrita_em: z.string().regex(DATA, "escrita_em deve ser AAAA-MM-DD"),
    escrita_por: z.string().min(1),
  })
  .strict();
const esquemaArquivo = z
  .object({ versao_formato: z.literal(1), perguntas: z.array(esquemaEntrada).min(1) })
  .strict();

export type PerguntaDoGabarito = z.infer<typeof esquemaEntrada>;
export type ResultadoGabarito = { linhas: string[]; codigo: 0 | 1 };
export type OpcoesGabarito = { fontes: string; derivados: string; lock: string };

/** O Acervo que o gabarito pode citar: Fontes publicadas com derivado, e o conjunto de refs de cada uma. */
export type AcervoCarregado = {
  publicadas: ReadonlySet<string>;
  naoPublicadas: ReadonlySet<string>;
  /** `true`/`false` conforme a ref existe no derivado; `null` quando a Fonte não tem derivado no lock. */
  temRef: (slug: string, ref: string) => boolean | null;
};

export function carregarAcervo(opcoes: OpcoesGabarito): {
  acervo?: AcervoCarregado;
  erro?: string;
} {
  let lock: ReturnType<typeof lerLock>;
  try {
    lock = lerLock(opcoes.lock);
    verificarDerivados(opcoes.derivados, lock);
  } catch (erro) {
    return { erro: `lock: ${(erro as Error).message}` };
  }
  const publicadas = new Set<string>();
  const naoPublicadas = new Set<string>();
  const nomes = readdirSync(opcoes.fontes)
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  for (const nome of nomes) {
    const doNomeDoArquivo = nome.slice(0, -".yaml".length);
    try {
      const fonte = interpretarFonteYaml(
        readFileSync(path.join(opcoes.fontes, nome), "utf8"),
        nome,
      );
      // A identidade é o slug DECLARADO no YAML — o mesmo que a carga usa para casar Fonte e derivado. O nome
      // do arquivo tem de confirmar essa identidade: um desacordo aqui quebra a carga (derivado órfão), então
      // reprova o carregamento inteiro em vez de deixar a referência resolver pelo nome do arquivo.
      if (fonte.slug !== doNomeDoArquivo)
        return {
          erro: `fontes: ${nome} declara o slug ${fonte.slug}, diferente do nome do arquivo`,
        };
      (fonte.publicada ? publicadas : naoPublicadas).add(fonte.slug);
    } catch {
      // YAML fora do contrato não é Fonte citável; o conferidor de Fontes é quem detalha o motivo.
      naoPublicadas.add(doNomeDoArquivo);
    }
  }
  const refs = new Map<string, Set<string>>();
  for (const slug of Object.keys(lock.derivados).sort()) {
    try {
      const derivado = lerDerivado(opcoes.derivados, lock, slug);
      // O derivado também declara o slug que diz servir: tem de ser o da própria entrada do lock (a carga
      // recusa "o derivado é de outra Fonte"), senão nenhuma referência sob esse nome é de confiança.
      if (derivado.slug !== slug)
        return { erro: `derivados: ${slug}.json declara o slug ${derivado.slug}` };
      refs.set(slug, new Set(derivado.secoes.flatMap((s) => s.paragrafos.map((p) => p.ref))));
    } catch (erro) {
      return { erro: `derivados: ${(erro as Error).message}` };
    }
  }
  return {
    acervo: {
      publicadas,
      naoPublicadas,
      temRef: (slug, ref) => {
        const conjunto = refs.get(slug);
        return conjunto === undefined ? null : conjunto.has(ref);
      },
    },
  };
}

// T-02-64: o contrato reprova nomeando o campo e a regra — JAMAIS um valor do arquivo. Nem a mensagem do
// zod (que pode citar o recebido), nem o nome das chaves desconhecidas (texto livre do arquivo) chegam à
// saída; cada código de issue vira um rótulo fixo nosso.
const REGRAS_DO_CONTRATO: Record<string, string> = {
  invalid_type: "tipo inválido",
  invalid_value: "valor fora do permitido",
  invalid_format: "formato inválido",
  too_small: "abaixo do mínimo",
  too_big: "acima do máximo",
  not_multiple_of: "fora do passo permitido",
  unrecognized_keys: "campo desconhecido",
  invalid_union: "fora do contrato",
  invalid_key: "fora do contrato",
  invalid_element: "fora do contrato",
  custom: "fora do contrato",
};

function descrever(erro: z.ZodError): string {
  return erro.issues
    .slice(0, 8)
    .map(
      (i) =>
        `${i.path.map(String).join(".") || "(raiz)"}: ${REGRAS_DO_CONTRATO[i.code] ?? "fora do contrato"}`,
    )
    .join("; ");
}

const percentual = (parte: number, total: number) =>
  total === 0 ? "0%" : `${Math.floor((parte / total) * 100)}%`;

/** Regras semânticas sobre um arquivo já interpretado. Cada falha sai como `REPROVADO <id>: <regra>: <detalhe>`. */
function regrasDasPerguntas(
  perguntas: readonly PerguntaDoGabarito[],
  acervo: AcervoCarregado,
): string[] {
  const linhas: string[] = [];
  const vistos = new Set<string>();
  for (const p of perguntas) {
    if (vistos.has(p.id))
      linhas.push(`REPROVADO ${p.id}: id-repetido: aparece mais de uma vez no arquivo`);
    else vistos.add(p.id);
    if (!p.pergunta.trim())
      linhas.push(`REPROVADO ${p.id}: pergunta-vazia: a pergunta não tem texto`);
    if (!(GRUPOS as readonly string[]).includes(p.grupo))
      linhas.push(`REPROVADO ${p.id}: grupo-invalido: o grupo não é aberto nem reservado`);
    if (!(CATEGORIAS as readonly string[]).includes(p.categoria))
      linhas.push(`REPROVADO ${p.id}: categoria-invalida: a categoria não está na lista`);
    if (p.tem_resposta && p.fontes_esperadas.length === 0)
      linhas.push(
        `REPROVADO ${p.id}: resposta-sem-fonte: tem_resposta verdadeiro exige fontes_esperadas`,
      );
    if (!p.tem_resposta && p.fontes_esperadas.length > 0)
      linhas.push(`REPROVADO ${p.id}: sem-resposta-com-fonte: tem_resposta falso não aponta Fonte`);
    for (const fe of p.fontes_esperadas) {
      if (acervo.naoPublicadas.has(fe.slug))
        linhas.push(
          `REPROVADO ${p.id}: fonte-nao-publicada: ${fe.slug} não está publicada no Acervo`,
        );
      else if (!acervo.publicadas.has(fe.slug))
        linhas.push(`REPROVADO ${p.id}: fonte-inexistente: ${fe.slug} não está no Acervo`);
      else {
        const tem = acervo.temRef(fe.slug, fe.ref);
        if (tem === null)
          linhas.push(`REPROVADO ${p.id}: derivado-ausente: ${fe.slug} está sem derivado no lock`);
        else if (!tem)
          linhas.push(
            `REPROVADO ${p.id}: referencia-inexistente: a ref não existe no derivado de ${fe.slug}`,
          );
      }
    }
  }
  return linhas;
}

function resumo(perguntas: readonly PerguntaDoGabarito[]): string[] {
  const total = perguntas.length;
  const semResposta = perguntas.filter((p) => !p.tem_resposta).length;
  const reservadas = perguntas.filter((p) => p.grupo === "reservado").length;
  const porCategoria = CATEGORIAS.map(
    (c) => `${c}=${perguntas.filter((p) => p.categoria === c).length}`,
  ).join(" · ");
  const entreIdiomas = perguntas.filter((p) => p.categoria === "entre-idiomas").length;
  const pessoalOuDeFe = perguntas.filter((p) => p.categoria === "pessoal-ou-de-fe").length;
  const simOuNao = (cumpre: boolean) => (cumpre ? "SIM" : "NÃO");
  return [
    `resumo: total=${total} · sem-resposta=${semResposta} · reservadas=${reservadas} (${percentual(reservadas, total)}) · ${porCategoria}`,
    `pisos do rascunho da Fase 2 (a Fase 3 completa as 80; o validador não aprova o conjunto): ` +
      `total>=${PISOS_FASE2.total}: ${simOuNao(total >= PISOS_FASE2.total)} · ` +
      `sem-resposta>=${PISOS_FASE2.semResposta}: ${simOuNao(semResposta >= PISOS_FASE2.semResposta)} · ` +
      `reservadas>=${PISOS_FASE2.reservadoPercentual}%: ${simOuNao(reservadas * 100 >= PISOS_FASE2.reservadoPercentual * total)} · ` +
      `entre-idiomas>=${PISOS_FASE2.entreIdiomas}: ${simOuNao(entreIdiomas >= PISOS_FASE2.entreIdiomas)} · ` +
      `pessoal-ou-de-fe>=${PISOS_FASE2.pessoalOuDeFe}: ${simOuNao(pessoalOuDeFe >= PISOS_FASE2.pessoalOuDeFe)}`,
  ];
}

/** Valida o CONTEÚDO de um arquivo de gabarito já lido. `rotulo` é o nome do arquivo na saída. */
export function validarConteudo(
  conteudo: string,
  rotulo: string,
  acervo: AcervoCarregado,
): ResultadoGabarito {
  let bruto: unknown;
  try {
    bruto = lerYaml(conteudo);
  } catch {
    // A mensagem do analisador pode citar trecho do arquivo: fica de fora.
    return { linhas: [`REPROVADO arquivo: YAML ${rotulo} ilegível`], codigo: 1 };
  }
  const r = esquemaArquivo.safeParse(bruto);
  if (!r.success)
    return { linhas: [`REPROVADO arquivo: contrato: ${descrever(r.error)}`], codigo: 1 };
  const linhas = regrasDasPerguntas(r.data.perguntas, acervo);
  return {
    linhas: [
      `GABARITO ${rotulo}: ${r.data.perguntas.length} perguntas lidas`,
      ...linhas,
      ...resumo(r.data.perguntas),
    ],
    codigo: linhas.length > 0 ? 1 : 0,
  };
}

/** Lê as flags da linha de comando. `arquivo` é `null` quando `--arquivo` não veio (o comando sai 1). */
export function lerArgumentos(argumentos: string[]): {
  arquivo: string | null;
  opcoes: OpcoesGabarito;
} {
  const valores = new Map<string, string>();
  for (let i = 0; i < argumentos.length; i++) {
    const a = argumentos[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const v = argumentos[i + 1];
      if (!v)
        throw new Error(
          "Uso: validar-gabarito --arquivo <caminho> [--fontes <pasta>] [--derivados <pasta>] [--lock <arquivo>]",
        );
      valores.set(a, v);
      i++;
    }
  }
  const valor = (flag: string, padrao: string) => path.resolve(valores.get(flag) ?? padrao);
  return {
    arquivo: valores.get("--arquivo") ? valor("--arquivo", process.cwd()) : null,
    opcoes: {
      fontes: valor("--fontes", PASTA_FONTES),
      derivados: valor("--derivados", PASTA_DERIVADOS),
      lock: valor("--lock", CAMINHO_LOCK),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { arquivo, opcoes } = lerArgumentos(process.argv.slice(2));
    if (!arquivo) {
      console.error("uso: tsx scripts/acervo/validar-gabarito.ts --arquivo <caminho do gabarito>");
      console.error(
        "     overrides de teste: --fontes <pasta> --derivados <pasta> --lock <arquivo>",
      );
      process.exit(1);
    }
    const { acervo, erro } = carregarAcervo(opcoes);
    const r = acervo
      ? validarConteudo(readFileSync(arquivo, "utf8"), path.basename(arquivo), acervo)
      : ({ linhas: [`REPROVADO ${erro}`], codigo: 1 } satisfies ResultadoGabarito);
    for (const l of r.linhas) console.log(l);
    process.exit(r.codigo);
  } catch (erro) {
    console.error((erro as Error).message);
    process.exit(1);
  }
}
