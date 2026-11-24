// `pnpm acervo:validar-propostas --propostas <pasta> [--fichas <pasta>] [--completo]` — conferência de MÁQUINA das
// propostas de Grau e de Citação (plano 02-20, D-04). SEM banco e SEM rede: lê o conteúdo dos Estudos (`content/`),
// o derivado versionado de cada Fonte citada (por `lerDerivado`, nunca o bruto), as fichas da pasta `--fichas` e a
// Bíblia pelo parser de referência.
//
// O que a máquina confere: a Afirmação existe e o texto não mudou; o trecho de parágrafo de Fonte é CÓPIA LITERAL do
// parágrafo (espaço normalizado); a Passagem existe e é um intervalo contínuo; a ficha e o item existem, a página é a
// que a ficha traz e o trecho, se houver, é literal do original do item; o Grau está na lista fechada; nenhuma
// Afirmação repetida. O que a máquina NÃO confere é se o trecho SUSTENTA a frase: isso é do dono (D-04).
//
// A saída nunca traz justificativa, trecho ou frase: só o id da Afirmação e o nome da regra. Saída 0 limpo; 1 alguma
// proposta reprovada (ou, com --completo, Afirmação sem proposta); também 1 em uso errado ou pasta ilegível (a mensagem diz qual).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { itensDaFicha } from "../../src/modules/acervo/hash-ficha";
import {
  type Derivado,
  ErroContrato,
  type FichaYaml,
  interpretarFichaYaml,
  interpretarPagina,
  normalizarEspaco,
} from "../../src/modules/acervo/schemas";
import { parsearReferencia } from "../../src/modules/referencias";
import { PASTA_PADRAO } from "../content/carregar";
import { lerPasta } from "../content/esquema";
import { ErroDerivado, lerDerivado, lerLock, PASTA_DERIVADOS } from "./derivados";
import { descreverErro, lerPastaDePropostas, type PropostaLida } from "./propostas";

/** O que o validador precisa saber do mundo; tudo em memória, para o teste não depender de disco nem de banco. */
export type ContextoDeValidacao = {
  /** id da Afirmação → frase atual, de `content/`. */
  afirmacoes: ReadonlyMap<string, string>;
  /** O derivado versionado da Fonte, ou `null` quando não existe. */
  derivado: (slug: string) => Derivado | null;
  /** A ficha em rascunho: `"sem-pasta"` quando nenhuma pasta de fichas foi dada, `null` quando não existe. */
  ficha: (slug: string) => FichaYaml | null | "sem-pasta";
};

export type VereditoDeProposta = { afirmacao: string; regras: string[]; arquivo: string };

export type RelatorioDeValidacao = {
  veredictos: VereditoDeProposta[];
  /** Afirmações do conteúdo que ainda não têm entrada. */
  pendentes: string[];
  entradas: number;
  aprovadas: number;
  reprovadas: number;
  /** Entradas por prefixo (bh e pc), todas as lidas. */
  porPrefixo: { bh: number; pc: number };
  /** Citações por alvo e `sem_citacao`, contadas só nas entradas aprovadas. */
  citacoes: { paragrafo: number; ficha: number; passagem: number };
  semCitacao: number;
  /** Total de Afirmações no conteúdo (a conta de "66"). */
  afirmacoesNoConteudo: number;
  /** Verdadeiro quando nada reprovou e, com `completo`, nada ficou pendente. */
  ok: boolean;
};

const paginaIgual = (a: string, b: ReturnType<typeof interpretarPagina>): boolean => {
  const p = interpretarPagina(a);
  return p.inicio === b.inicio && p.fim === b.fim && p.texto === b.texto;
};

function conferirCitacao(
  c: PropostaLida["citacoes"][number],
  ctx: ContextoDeValidacao,
  regras: string[],
): void {
  if (c.alvo === "paragrafo") {
    const d = ctx.derivado(c.fonte);
    if (!d) {
      regras.push(`Fonte ${c.fonte} sem derivado versionado`);
      return;
    }
    const paragrafo = d.secoes.flatMap((s) => s.paragrafos).find((p) => p.ref === c.ref);
    if (!paragrafo) {
      regras.push(`parágrafo ${c.fonte}/${c.ref} inexistente no derivado`);
      return;
    }
    if (!normalizarEspaco(paragrafo.texto).includes(normalizarEspaco(c.trecho)))
      regras.push(`trecho não é cópia literal do parágrafo ${c.fonte}/${c.ref}`);
    return;
  }
  if (c.alvo === "ficha") {
    const f = ctx.ficha(c.ficha);
    if (f === "sem-pasta") {
      regras.push("pasta de fichas não informada (use --fichas ou ACERVO_FICHAS_DIR)");
      return;
    }
    if (!f) {
      regras.push(`ficha ${c.ficha} inexistente`);
      return;
    }
    const item = itensDaFicha(f).find((i) => i.id === `${c.ficha}/${c.item}`);
    if (!item) {
      regras.push(`item ${c.item} inexistente na ficha ${c.ficha}`);
      return;
    }
    if (!paginaIgual(c.pagina, item.pagina))
      regras.push(`página diferente da que a ficha traz para ${c.ficha}/${c.item}`);
    if (c.trecho != null) {
      if (item.trecho_original === null)
        regras.push(`o item ${c.ficha}/${c.item} não tem trecho original para citar`);
      else if (!normalizarEspaco(item.trecho_original).includes(normalizarEspaco(c.trecho)))
        regras.push(`trecho não é literal do original do item ${c.ficha}/${c.item}`);
    }
    return;
  }
  // Passagem: a referência tem de existir na Bíblia e ser UM intervalo contínuo (a Citação guarda início e fim).
  try {
    const intervalos = parsearReferencia(c.referencia);
    if (intervalos.length !== 1)
      regras.push("a Passagem deve ser um intervalo contínuo só (uma Citação por intervalo)");
  } catch {
    regras.push("referência de Passagem inexistente ou inválida");
  }
}

/** Núcleo puro: confere cada proposta contra o contexto e relata. Não toca disco, banco nem rede. */
export function validarPropostas(
  propostas: readonly PropostaLida[],
  ctx: ContextoDeValidacao,
  opcoes: { completo?: boolean } = {},
): RelatorioDeValidacao {
  const vistas = new Set<string>();
  const veredictos: VereditoDeProposta[] = [];
  const citacoes = { paragrafo: 0, ficha: 0, passagem: 0 };
  let semCitacao = 0;
  const porPrefixo = { bh: 0, pc: 0 };

  for (const p of propostas) {
    const regras: string[] = [];
    porPrefixo[p.afirmacao.startsWith("bh") ? "bh" : "pc"]++;
    if (vistas.has(p.afirmacao)) regras.push("Afirmação repetida na lista de propostas");
    vistas.add(p.afirmacao);

    const frase = ctx.afirmacoes.get(p.afirmacao);
    if (frase === undefined) regras.push("Afirmação inexistente no conteúdo dos Estudos");
    else if (normalizarEspaco(frase) !== normalizarEspaco(p.texto))
      regras.push("o texto da Afirmação mudou (ou foi copiado errado)");

    for (const c of p.citacoes) conferirCitacao(c, ctx, regras);

    veredictos.push({ afirmacao: p.afirmacao, regras, arquivo: p.arquivo });
    if (regras.length === 0) {
      if (p.sem_citacao) semCitacao++;
      for (const c of p.citacoes) citacoes[c.alvo]++;
    }
  }

  const pendentes = [...ctx.afirmacoes.keys()].filter((id) => !vistas.has(id)).sort();
  const reprovadas = veredictos.filter((v) => v.regras.length > 0).length;
  return {
    veredictos,
    pendentes,
    entradas: propostas.length,
    aprovadas: propostas.length - reprovadas,
    reprovadas,
    porPrefixo,
    citacoes,
    semCitacao,
    afirmacoesNoConteudo: ctx.afirmacoes.size,
    ok: reprovadas === 0 && (!opcoes.completo || pendentes.length === 0),
  };
}

// ───────────────────────── comando ─────────────────────────

export type OpcoesDaValidacao = {
  propostas: string | undefined;
  fichas: string | undefined;
  conteudo: string;
  completo: boolean;
  listar: boolean;
};

export type DependenciasDaValidacao = {
  /** Troca a leitura do mundo (teste). Por padrão lê `content/`, `data/acervo-derivados` e a pasta de fichas. */
  contexto?: (opcoes: OpcoesDaValidacao) => Promise<ContextoDeValidacao>;
  escrever?: (linha: string) => void;
};

function fichasDaPasta(pasta: string | undefined): ContextoDeValidacao["ficha"] {
  if (!pasta) return () => "sem-pasta";
  if (!existsSync(pasta)) throw new ErroContrato("a pasta de fichas não existe");
  const fichas = new Map<string, FichaYaml>();
  for (const nome of readdirSync(pasta)
    .filter((n) => n.endsWith(".yaml"))
    .sort()) {
    try {
      const f = interpretarFichaYaml(readFileSync(path.join(pasta, nome), "utf8"), nome);
      fichas.set(f.slug, f);
    } catch (erro) {
      // Ficha que o contrato reprova não vale como alvo; quem a cita é reprovado como "inexistente".
      if (!(erro instanceof ErroContrato)) throw erro;
    }
  }
  return (slug) => fichas.get(slug) ?? null;
}

async function contextoReal(opcoes: OpcoesDaValidacao): Promise<ContextoDeValidacao> {
  const conteudo = await lerPasta(opcoes.conteudo);
  const afirmacoes = new Map<string, string>();
  for (const e of conteudo.estudos) for (const a of e.afirmacoes) afirmacoes.set(a.id, a.texto);
  const lock = lerLock();
  const guardados = new Map<string, Derivado | null>();
  return {
    afirmacoes,
    derivado: (slug) => {
      if (!guardados.has(slug)) {
        try {
          guardados.set(slug, lerDerivado(PASTA_DERIVADOS, lock, slug));
        } catch (erro) {
          if (!(erro instanceof ErroDerivado)) throw erro;
          guardados.set(slug, null);
        }
      }
      return guardados.get(slug) ?? null;
    },
    ficha: fichasDaPasta(opcoes.fichas),
  };
}

/** Executa o comando e devolve o código de saída (0 limpo, 1 reprovou ou faltou). Lança só em uso errado de pasta. */
export async function executarValidacao(
  opcoes: OpcoesDaValidacao,
  deps: DependenciasDaValidacao = {},
): Promise<number> {
  const escrever = deps.escrever ?? ((l: string) => console.log(l));
  const ctx = await (deps.contexto ?? contextoReal)(opcoes);

  if (opcoes.listar) {
    // Ajuda do redator: as frases são do conteúdo público dos Estudos; nenhuma proposta é lida.
    for (const [id, frase] of [...ctx.afirmacoes].sort(([a], [b]) => a.localeCompare(b)))
      escrever(`${id}\t${normalizarEspaco(frase)}`);
    escrever(`afirmacoes=${ctx.afirmacoes.size}`);
    return 0;
  }
  if (!opcoes.propostas)
    throw new ErroContrato(
      "a pasta de propostas é obrigatória: use --propostas <pasta> ou ACERVO_PROPOSTAS_DIR (não há pasta padrão; D-17)",
    );

  const { propostas, erros } = lerPastaDePropostas(opcoes.propostas);
  for (const e of erros) escrever(`REPROVADO ${descreverErro(e)}`);
  const r = validarPropostas(propostas, ctx, { completo: opcoes.completo });
  for (const v of r.veredictos) {
    if (v.regras.length === 0) escrever(`OK ${v.afirmacao}`);
    else for (const regra of v.regras) escrever(`REPROVADO ${v.afirmacao}: ${regra}`);
  }
  for (const id of r.pendentes) escrever(`PENDENTE ${id}`);

  const reprovadas = r.reprovadas + erros.length;
  escrever(
    `entradas=${r.entradas + erros.length} aprovadas=${r.aprovadas} reprovadas=${reprovadas} pendentes=${r.pendentes.length} afirmacoes-no-conteudo=${r.afirmacoesNoConteudo}`,
  );
  escrever(`por-faixa: bh=${r.porPrefixo.bh} pc=${r.porPrefixo.pc}`);
  escrever(
    `citacoes: paragrafo=${r.citacoes.paragrafo} ficha=${r.citacoes.ficha} passagem=${r.citacoes.passagem} sem_citacao=${r.semCitacao}`,
  );
  if (opcoes.completo && r.pendentes.length > 0)
    escrever(`INCOMPLETO: ${r.pendentes.length} Afirmação(ões) sem entrada (--completo)`);
  return reprovadas === 0 && r.ok ? 0 : 1;
}

export function lerOpcoes(
  argumentos: string[],
  env: Record<string, string | undefined>,
): OpcoesDaValidacao {
  const valorDe = (nome: string): string | undefined => {
    const i = argumentos.indexOf(nome);
    if (i < 0) return undefined;
    const v = argumentos[i + 1];
    if (!v || v.startsWith("--"))
      throw new ErroContrato(
        "Uso: acervo:validar-propostas --propostas <pasta> [--fichas <pasta>] [--conteudo <pasta>] [--completo] [--listar-afirmacoes]",
      );
    return path.resolve(v);
  };
  const daEnv = (v: string | undefined) => (v ? path.resolve(v) : undefined);
  return {
    propostas: valorDe("--propostas") ?? daEnv(env.ACERVO_PROPOSTAS_DIR),
    fichas: valorDe("--fichas") ?? daEnv(env.ACERVO_FICHAS_DIR),
    conteudo: valorDe("--conteudo") ?? PASTA_PADRAO,
    completo: argumentos.includes("--completo"),
    listar: argumentos.includes("--listar-afirmacoes"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => executarValidacao(lerOpcoes(process.argv.slice(2), process.env)))
    .then(
      (codigo) => process.exit(codigo),
      (erro: unknown) => {
        // Só erro nosso mostra texto; o resto vai só com a classe.
        console.error(
          erro instanceof ErroContrato || erro instanceof ErroDerivado
            ? erro.message
            : `acervo:validar-propostas: falha inesperada (${erro instanceof Error ? erro.name : "erro"})`,
        );
        process.exit(1);
      },
    );
}
