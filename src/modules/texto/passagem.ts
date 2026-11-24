import { and, asc, between, eq, notExists, sql } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import {
  conjuntoDados,
  correspondenciaVersificacao,
  textoVersiculo,
  versiculo,
} from "@/db/schema/texto";
import { decompor } from "@/modules/referencias/chave";

// Leitura de Passagem: cada intervalo de chave é UM `between` sobre versiculo_id, que é a ordem de
// leitura. O texto vem do banco, da edição exibida (conjunto_dados.edicao_exibida; n4 enquanto o
// dono não escolher), nunca de um arquivo no navegador.

export const CONJUNTO_DA_BIBLIA = "biblia-livre";
export const EDICAO_PADRAO = "n4";

export type IntervaloDeChave = { inicio: number; fim: number };

export type VersiculoLido = {
  chave: number;
  livro: number;
  capitulo: number;
  numero: number;
  conteudo: string;
  titulo: string | null;
  duvidoso: boolean;
  adicionados: string[];
  notas: { chave: string | null; texto: string }[];
};

export type CapituloLido = { livro: number; capitulo: number; versiculos: VersiculoLido[] };

/** Versículo que o arquivo de origem traz dentro de outro (Mc 5:19, dentro de Mc.5.18). */
export type VersiculoMesclado = { chave: number; refExterna: string; observacao: string };

export type TrechoLido = {
  inicio: number;
  fim: number;
  capitulos: CapituloLido[];
  mesclados: VersiculoMesclado[];
};

export type Passagem = { textoId: string; edicao: string; trechos: TrechoLido[] };

function validar(intervalos: readonly IntervaloDeChave[]): void {
  for (const i of intervalos) {
    // `decompor` falha em chave fora do formato BBCCCVVV.
    decompor(i.inicio);
    decompor(i.fim);
    if (i.inicio > i.fim) throw new RangeError(`intervalo invertido: ${i.inicio} > ${i.fim}`);
  }
}

/**
 * Lê as Passagens como intervalos de chave, na ordem em que foram dadas (cada intervalo em ordem de
 * leitura). Intervalos que se sobrepõem são lidos cada um por si, sem juntar nem deduplicar.
 * `textoId` explícito vence a edição exibida.
 */
export async function lerPassagem(
  intervalos: readonly IntervaloDeChave[],
  textoId?: string,
): Promise<Passagem> {
  validar(intervalos);
  return comAcervo(
    async (tx) => {
      let edicao = EDICAO_PADRAO as string;
      let idDoTexto = textoId;
      if (idDoTexto === undefined) {
        const exibida = await tx
          .select({ edicao: conjuntoDados.edicaoExibida })
          .from(conjuntoDados)
          .where(eq(conjuntoDados.id, CONJUNTO_DA_BIBLIA));
        edicao = exibida[0]?.edicao ?? EDICAO_PADRAO;
        idDoTexto = `blivre-${edicao}`;
      } else {
        edicao = idDoTexto.replace(/^blivre-/, "");
      }
      const alvo = idDoTexto;

      const trechos: TrechoLido[] = [];
      for (const intervalo of intervalos) {
        const linhas = await tx
          .select({
            chave: textoVersiculo.versiculoId,
            livro: versiculo.livro,
            capitulo: versiculo.capitulo,
            numero: versiculo.numero,
            conteudo: textoVersiculo.conteudo,
            titulo: textoVersiculo.titulo,
            duvidoso: textoVersiculo.duvidoso,
            adicionados: textoVersiculo.adicionados,
            notas: textoVersiculo.notas,
          })
          .from(textoVersiculo)
          .innerJoin(versiculo, eq(versiculo.id, textoVersiculo.versiculoId))
          .where(
            and(
              eq(textoVersiculo.textoId, alvo),
              between(textoVersiculo.versiculoId, intervalo.inicio, intervalo.fim),
            ),
          )
          .orderBy(asc(textoVersiculo.versiculoId));

        const capitulos: CapituloLido[] = [];
        for (const l of linhas) {
          const ultimo = capitulos.at(-1);
          const lido: VersiculoLido = {
            chave: l.chave,
            livro: l.livro,
            capitulo: l.capitulo,
            numero: l.numero,
            conteudo: l.conteudo,
            titulo: l.titulo,
            duvidoso: l.duvidoso,
            adicionados: l.adicionados as string[],
            notas: l.notas as { chave: string | null; texto: string }[],
          };
          if (ultimo && ultimo.livro === l.livro && ultimo.capitulo === l.capitulo) {
            ultimo.versiculos.push(lido);
          } else {
            capitulos.push({ livro: l.livro, capitulo: l.capitulo, versiculos: [lido] });
          }
        }

        // Mesclados: marcador da correspondência, dentro do intervalo, sem linha de texto nesta edição.
        const mesclados = await tx
          .select({
            chave: correspondenciaVersificacao.versiculoId,
            refExterna: correspondenciaVersificacao.refExterna,
            observacao: correspondenciaVersificacao.observacao,
          })
          .from(correspondenciaVersificacao)
          .where(
            and(
              eq(correspondenciaVersificacao.conjuntoId, CONJUNTO_DA_BIBLIA),
              between(correspondenciaVersificacao.versiculoId, intervalo.inicio, intervalo.fim),
              notExists(
                tx
                  .select({ um: sql`1` })
                  .from(textoVersiculo)
                  .where(
                    and(
                      eq(textoVersiculo.textoId, alvo),
                      eq(textoVersiculo.versiculoId, correspondenciaVersificacao.versiculoId),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(correspondenciaVersificacao.versiculoId));

        trechos.push({
          inicio: intervalo.inicio,
          fim: intervalo.fim,
          capitulos,
          mesclados: mesclados.map((m) => ({
            chave: m.chave as number,
            refExterna: m.refExterna,
            observacao: m.observacao ?? "",
          })),
        });
      }
      return { textoId: alvo, edicao, trechos };
    },
    { instantaneo: true },
  );
}
