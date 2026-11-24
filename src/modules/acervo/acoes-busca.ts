"use server";

import { z } from "zod";
import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import { buscarNoAcervo, type PaginaDeBusca } from "./busca";
import { TERMO_DA_BUSCA_MAX } from "./busca-limites";
import { NIVEIS, type Nivel } from "./schemas";

// Server Action da busca do Acervo (ACER-05, PRIV-04). A busca é um formulário que chega aqui por POST: o termo
// viaja no corpo da requisição e NUNCA na URL (a URL aparece nos registros da hospedagem, e o que alguém procura
// sobre a fé pode revelar crença religiosa). O único registro de falha é o contexto e o código do erro
// (`registrarErro`), nunca o termo nem o resultado. Num arquivo `'use server'` toda função exportada é uma ação:
// a consulta mora em `busca.ts` e as constantes em `busca-limites.ts`.

export type ResultadoDaAcaoDeBusca =
  | ({ ok: true; termo: string; niveis: Nivel[]; deslocamento: number } & PaginaDeBusca)
  | { ok: false; erro: "invalida" | "falha" };

const termoDaBusca = z.string().max(TERMO_DA_BUSCA_MAX);
const nivelDaBusca = z.enum(NIVEIS);
const deslocamentoDaBusca = z.coerce.number().int().min(0).max(10_000);

/** `termo` vazio devolve a página vazia; `deslocamento` pede a página depois da que a tela já tem. */
export async function buscarAcervo(dados: FormData): Promise<ResultadoDaAcaoDeBusca> {
  await exigirSessao();
  const bruto = dados.get("termo");
  const brutoDesloc = dados.get("deslocamento");
  const brutosNivel = dados.getAll("nivel");
  // Um valor que não é texto (um arquivo, por exemplo) não é termo nem Nível.
  if (
    (bruto !== null && typeof bruto !== "string") ||
    (brutoDesloc !== null && typeof brutoDesloc !== "string") ||
    brutosNivel.some((v) => typeof v !== "string")
  ) {
    return { ok: false, erro: "invalida" };
  }
  const lido = termoDaBusca.safeParse(bruto ?? "");
  if (!lido.success) return { ok: false, erro: "invalida" };
  const nivelLido = z.array(nivelDaBusca).max(NIVEIS.length).safeParse(brutosNivel);
  if (!nivelLido.success) return { ok: false, erro: "invalida" };
  const desloc = deslocamentoDaBusca.safeParse(
    brutoDesloc === null || brutoDesloc === "" ? 0 : brutoDesloc,
  );
  if (!desloc.success) return { ok: false, erro: "invalida" };

  const termo = lido.data.replaceAll("\u0000", "").trim();
  try {
    const pagina = await buscarNoAcervo({
      termo,
      niveis: nivelLido.data,
      deslocamento: desloc.data,
    });
    return { ok: true, termo, niveis: nivelLido.data, deslocamento: desloc.data, ...pagina };
  } catch (erro) {
    registrarErro("acervo-buscar", erro);
    return { ok: false, erro: "falha" };
  }
}
