// Evidência do TRADUTOR de uma obra (plano 02-11): o parágrafo da introdução da edição que o nomeia, lido no bruto.
// O `acervo:conferir` lê o parágrafo no derivado versionado (ou aceita o trecho fixado no registro); este módulo é o
// lado do `acervo:verify`: prova, contra o bruto, que o trecho fixado no registro existe de fato no parágrafo `ref`.

import { Parser } from "htmlparser2";
import type { ResultadoInterpretado } from "./acervo-interpretar";

/** Espaços e quebras fechados num só espaço: o texto do arquivo e o trecho do registro se comparam assim. */
export const compactarTexto = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

/**
 * O texto visível do elemento com `id` (qualquer elemento do bruto, mesmo fora das divisões que viram seção), ou
 * `null` quando nenhum elemento tem esse id. Só o primeiro elemento de cada id vale.
 */
export function textoDoElementoPorId(xml: string, id: string): string | null {
  let profundidade = 0;
  let achado = false;
  let texto = "";
  let terminou = false;
  const parser: Parser = new Parser(
    {
      onopentag(_nome, atributos) {
        if (terminou) return;
        if (achado) profundidade++;
        else if (atributos.id === id) {
          achado = true;
          profundidade = 1;
        }
      },
      ontext(dados) {
        if (achado && !terminou) texto += dados;
      },
      onclosetag() {
        if (!achado || terminou) return;
        profundidade--;
        if (profundidade === 0) {
          terminou = true;
          parser.pause();
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  if (!achado) return null;
  return compactarTexto(texto);
}

/**
 * Confere, no bruto, o parágrafo de evidência do tradutor: ele existe e contém o trecho EXATO fixado no registro.
 * Procura primeiro na leitura do volume (o mesmo texto do derivado) e, se a introdução não virou seção, no elemento
 * do arquivo. Devolve o motivo da reprovação, ou `null` quando confere.
 */
export function conferirEvidenciaNoBruto(
  conteudo: string,
  interpretado: Pick<ResultadoInterpretado, "secoes">,
  evidencia: { ref: string; trecho: string },
): string | null {
  let texto: string | null = null;
  for (const s of interpretado.secoes) {
    const p = s.paragrafos.find((q) => q.ref === evidencia.ref);
    if (p) {
      texto = compactarTexto(p.texto);
      break;
    }
  }
  texto ??= textoDoElementoPorId(conteudo, evidencia.ref);
  if (texto === null) return `evidencia_tradutor: o parágrafo ${evidencia.ref} não existe no bruto`;
  if (!texto.includes(compactarTexto(evidencia.trecho)))
    return `evidencia_tradutor: o parágrafo ${evidencia.ref} do bruto não contém o trecho do registro (o parágrafo diz: "${texto.slice(0, 160)}")`;
  return null;
}
