"use server";

import { z } from "zod";
import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import { cursorValido, listarCaderno, type PaginaDoCaderno } from "./caderno";
import { TERMO_MAX } from "./limite";

// Server Action do Caderno (ANOT-03, PRIV-04). A busca é um formulário que chega aqui por POST: o termo
// viaja no corpo da requisição e NUNCA na URL (a URL aparece nos registros da hospedagem). Exige sessão E o
// aceite do aviso (`exigirSessao()` sem opção). O texto buscado e o texto das Anotações são privados: o
// único registro de falha é o contexto e o código do erro (`registrarErro`), nunca o termo nem o resultado.
// Num arquivo `'use server'` toda função exportada é uma ação: `listarCaderno` mora em `caderno.ts`.

export type ResultadoDaBusca =
  | ({ ok: true; termo: string } & PaginaDoCaderno)
  | { ok: false; erro: "invalida" | "falha" | "sessao-trocada" };

const termoDaBusca = z.string().max(TERMO_MAX);

/** `termo` vazio lista tudo; `cursor` pede a página depois da que a tela já tem. */
export async function buscarCaderno(dados: FormData): Promise<ResultadoDaBusca> {
  const { usuario } = await exigirSessao();
  // Quem a tela acha que é: se o navegador passou a ser de outra conta (outra aba), a busca não traz o
  // Caderno de B para a tela de A.
  if (dados.get("estudanteId") !== usuario.id) return { ok: false, erro: "sessao-trocada" };
  const bruto = dados.get("termo");
  const cursorBruto = dados.get("cursor");
  // Um valor que não é texto (um arquivo, por exemplo) não é termo.
  if (
    (bruto !== null && typeof bruto !== "string") ||
    (cursorBruto !== null && typeof cursorBruto !== "string")
  ) {
    return { ok: false, erro: "invalida" };
  }
  const lido = termoDaBusca.safeParse(bruto ?? "");
  if (!lido.success) return { ok: false, erro: "invalida" };
  const termo = lido.data.replaceAll("\u0000", "").trim();
  const cursor = cursorBruto === null || cursorBruto === "" ? null : cursorBruto;
  if (cursor !== null && !cursorValido(cursor)) return { ok: false, erro: "invalida" };
  try {
    const pagina = await listarCaderno(usuario.id, {
      termo: termo === "" ? undefined : termo,
      cursor,
    });
    return { ok: true, termo, ...pagina };
  } catch (erro) {
    registrarErro("caderno-buscar", erro);
    return { ok: false, erro: "falha" };
  }
}
