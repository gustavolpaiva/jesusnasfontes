// Validação de uma edição interpretada. Falha nomeando cada problema; nada é corrigido nem descartado em silêncio.

import { decompor } from "../../src/modules/referencias/chave";
import { LIVROS } from "../../src/modules/referencias/livros";
import { parsearReferencia } from "../../src/modules/referencias/parser";
import type { Edicao, Esperado } from "./fontes";
import type { Versiculo } from "./parser-f4";

export class ErroValidacao extends Error {
  readonly problemas: string[];
  constructor(problemas: string[]) {
    super(`validação falhou (${problemas.length} problema(s)):\n- ${problemas.join("\n- ")}`);
    this.name = "ErroValidacao";
    this.problemas = problemas;
  }
}

export type Resultado = {
  versiculos: number;
  capitulos: number;
  excecoes: number;
  /** Versículos com id mas sem texto, listados em esperado.sem_texto para esta edição. */
  semTexto: string[];
  evangelhos: { capitulos: number; versiculos: number };
};

function nomeDe(chaveVerso: number): string {
  const p = decompor(chaveVerso);
  const livro = LIVROS[p.livro - 1];
  return `${livro?.nome ?? `livro ${p.livro}`} ${p.capitulo}:${p.versiculo}`;
}

export function validarEdicao(
  versiculos: readonly Versiculo[],
  esperado: Esperado,
  edicao?: Edicao,
  /** Trecho de uma edição (fixture): não exige livros, capítulos nem totais, só a coerência do que existe. */
  parcial = false,
): Resultado {
  const problemas: string[] = [];

  // Exceções listadas: chave do versículo ausente e a chave do versículo que carrega o texto dele.
  const excecoes = new Map<number, { dentroDe: number; usada: boolean }>();
  for (const e of esperado.excecoes) {
    if (e.tipo !== "versiculo-mesclado") {
      problemas.push(`tipo de exceção desconhecido: ${e.tipo}`);
      continue;
    }
    const ref = parsearReferencia(e.referencia);
    const dentro = parsearReferencia(e.dentro_de);
    const a = ref[0];
    const d = dentro[0];
    if (
      ref.length !== 1 ||
      dentro.length !== 1 ||
      !a ||
      !d ||
      a.inicio !== a.fim ||
      d.inicio !== d.fim
    ) {
      problemas.push(`exceção malformada: ${e.referencia} dentro de ${e.dentro_de}`);
      continue;
    }
    excecoes.set(a.inicio, { dentroDe: d.inicio, usada: false });
  }

  // Versículos que o arquivo de origem traz sem texto, aceitos só se nomeados para esta edição.
  const semTextoListados = new Map<number, string>();
  for (const e of esperado.sem_texto ?? []) {
    if (edicao && e.edicao !== edicao) continue;
    const r = parsearReferencia(e.referencia)[0];
    if (!r) problemas.push(`sem_texto malformado: ${e.referencia}`);
    else semTextoListados.set(r.inicio, e.referencia);
  }
  const semTextoAchados: string[] = [];

  const vistos = new Set<number>();
  let anterior = 0;
  for (const v of versiculos) {
    if (vistos.has(v.chave)) problemas.push(`id duplicado: ${nomeDe(v.chave)}`);
    vistos.add(v.chave);
    if (v.chave < anterior)
      problemas.push(`fora de ordem: ${nomeDe(v.chave)} depois de ${nomeDe(anterior)}`);
    anterior = Math.max(anterior, v.chave);
    if (v.texto === "") {
      if (semTextoListados.has(v.chave)) semTextoAchados.push(nomeDe(v.chave));
      else problemas.push(`versículo sem texto: ${nomeDe(v.chave)} (não listado em sem_texto)`);
    }
  }

  // Por livro e capítulo: contiguidade e coerência com a tabela de livros.
  const porCapitulo = new Map<number, Set<number>>(); // livro*1000+capitulo -> versículos presentes
  for (const k of vistos) {
    const p = decompor(k);
    const id = p.livro * 1000 + p.capitulo;
    let s = porCapitulo.get(id);
    if (!s) {
      s = new Set();
      porCapitulo.set(id, s);
    }
    s.add(p.versiculo);
  }

  let capitulos = 0;
  let observadas = 0;
  for (const livro of LIVROS) {
    const caps = [...porCapitulo.keys()].filter((id) => Math.floor(id / 1000) === livro.numero);
    if (caps.length === 0) {
      if (!parcial) problemas.push(`livro faltando: ${livro.nome}`);
      continue;
    }
    if (!parcial && caps.length !== livro.capitulos) {
      problemas.push(`${livro.nome}: ${caps.length} capítulos, esperava ${livro.capitulos}`);
    }
    for (let c = 1; c <= livro.capitulos; c++) {
      const s = porCapitulo.get(livro.numero * 1000 + c);
      if (!s) {
        if (!parcial) problemas.push(`capítulo faltando: ${livro.nome} ${c}`);
        continue;
      }
      capitulos++;
      const max = Math.max(...s);
      const ult = livro.ultimoVersiculo[c - 1];
      if (max !== ult)
        problemas.push(`${livro.nome} ${c}: último versículo ${max}, esperava ${ult}`);
      for (let n = 1; n <= max; n++) {
        if (s.has(n)) continue;
        const k = livro.numero * 1_000_000 + c * 1_000 + n;
        const ex = excecoes.get(k);
        if (ex) {
          ex.usada = true;
          observadas++;
          if (!vistos.has(ex.dentroDe)) {
            problemas.push(
              `exceção ${nomeDe(k)}: o versículo que carrega o texto (${nomeDe(ex.dentroDe)}) não existe`,
            );
          }
        } else {
          problemas.push(`buraco: falta ${nomeDe(k)} (não listado nas exceções)`);
        }
      }
    }
  }
  for (const [k, ex] of excecoes) {
    if (!ex.usada)
      problemas.push(
        `exceção listada mas o versículo existe ou o capítulo não tem o buraco: ${nomeDe(k)}`,
      );
  }

  for (const [k, ref] of semTextoListados) {
    if (!semTextoAchados.includes(nomeDe(k)))
      problemas.push(`sem_texto listado mas o versículo tem texto ou não existe: ${ref}`);
  }

  if (!parcial && vistos.size !== esperado.versiculos) {
    problemas.push(`${vistos.size} versículos, esperava ${esperado.versiculos}`);
  }
  if (!parcial && capitulos !== esperado.capitulos)
    problemas.push(`${capitulos} capítulos, esperava ${esperado.capitulos}`);

  // Os quatro evangelhos (Mateus a João = livros 40 a 43), conferidos contra o registro.
  let evCaps = 0;
  let evVers = 0;
  for (const id of porCapitulo.keys()) {
    const livro = Math.floor(id / 1000);
    if (livro >= 40 && livro <= 43) {
      evCaps++;
      evVers += porCapitulo.get(id)?.size ?? 0;
    }
  }
  if (
    !parcial &&
    (evCaps !== esperado.evangelhos.capitulos || evVers !== esperado.evangelhos.versiculos)
  ) {
    problemas.push(
      `evangelhos: ${evCaps} capítulos e ${evVers} versículos, esperava ${esperado.evangelhos.capitulos} e ${esperado.evangelhos.versiculos}`,
    );
  }

  if (problemas.length > 0) throw new ErroValidacao(problemas);
  return {
    versiculos: vistos.size,
    capitulos,
    excecoes: observadas,
    semTexto: semTextoAchados,
    evangelhos: { capitulos: evCaps, versiculos: evVers },
  };
}
