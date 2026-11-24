"use server";

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { comAdmin } from "@/db/com-admin";
import { registrarErro } from "@/lib/registro";
import { exigirAdmin, ROTA_SEGUNDO_FATOR } from "@/modules/identidade/sessao";
import { traduzirErroDoPainel } from "./erros-painel";
import {
  errosPorCampo,
  esquemaFonteDoArquivo,
  esquemaFonteFormulario,
  esquemaResumoDeSecao,
  listaDePalavras,
  MENSAGENS,
  type ResultadoDeSalvar,
  slugDoTitulo,
} from "./schemas-painel";

// As Server Actions do painel de Fontes (ACER-08). Cada uma confere `exigirAdmin()` ANTES de qualquer outra coisa (o
// layout não roda em toda ação, e uma Server Action é um endereço que qualquer pessoa pode chamar) e escreve só por
// função do banco (`acervo.salvar_fonte` e irmãs, migração 0022), que reexige a sessão de Admin com segundo fator: a
// guarda daqui e a do banco são independentes. O que volta ao navegador é a mensagem fixa do contrato de copy, nunca
// texto do banco (T-02-45). Este arquivo só exporta ações; o tradutor de erro e os esquemas moram em arquivos próprios.

const LISTA = "/admin/acervo/fontes";
const TENTATIVAS_DE_ENDERECO = 8;

type Traducao = ReturnType<typeof traduzirErroDoPainel>;

function emResultado(
  t: Exclude<Traducao, { tipo: "segundo-fator" | "slug-repetido" }>,
): ResultadoDeSalvar {
  return t.tipo === "campo"
    ? { ok: false, erros: { [t.campo]: t.mensagem } }
    : { ok: false, erros: {}, geral: t.mensagem };
}

/** Erro de banco → resultado; sessão sem segundo fator vira redirecionamento (a tela dele). */
function tratar(contexto: string, erro: unknown): ResultadoDeSalvar {
  const t = traduzirErroDoPainel(erro);
  if (t.tipo === "segundo-fator") redirect(ROTA_SEGUNDO_FATOR);
  if (t.tipo === "slug-repetido") return { ok: false, erros: {}, geral: MENSAGENS.servidor };
  if (t.tipo === "geral") registrarErro(contexto, erro);
  return emResultado(t);
}

/** Cria ou edita uma Fonte DO PAINEL, com as seções coladas, tudo numa transação só. */
export async function salvarFonte(dados: unknown): Promise<ResultadoDeSalvar> {
  const sessao = await exigirAdmin();
  const lido = esquemaFonteFormulario.safeParse(dados);
  if (!lido.success) return { ok: false, erros: errosPorCampo(lido.error) };
  const f = lido.data;

  const base = f.modo === "editar" && f.slug ? f.slug : slugDoTitulo(f.titulo);
  const tentativas = f.modo === "criar" ? TENTATIVAS_DE_ENDERECO : 1;
  const comSecoes = f.tipo_texto === "integral" ? f.secoes : [];

  // Seção nova ganha `secao-<n>` sem repetir as que já existem.
  const usados = new Set(comSecoes.flatMap((s) => (s.slug ? [s.slug] : [])));
  let proximo = 1;
  const secoes = comSecoes.map((s) => {
    let slug = s.slug;
    if (!slug) {
      while (usados.has(`secao-${proximo}`)) proximo++;
      slug = `secao-${proximo}`;
      usados.add(slug);
    }
    return {
      slug,
      titulo: s.titulo,
      texto: s.texto,
      resumo_pt: s.resumo_pt,
      palavras_chave_pt: listaDePalavras(s.palavras_chave_pt),
    };
  });

  for (let i = 1; i <= tentativas; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    try {
      await comAdmin(sessao.sessao.id, async (tx) => {
        const { modo: _modo, secoes: _secoes, slug: _slug, ...campos } = f;
        await tx.execute(
          sql`select acervo.salvar_fonte(${sessao.sessao.id}::uuid, ${JSON.stringify({ ...campos, modo: f.modo, slug })}::jsonb)`,
        );
        for (const s of secoes) {
          await tx.execute(
            sql`select acervo.salvar_secao_painel(${sessao.sessao.id}::uuid, ${slug}, ${JSON.stringify(s)}::jsonb)`,
          );
        }
      });
      revalidatePath(LISTA);
      revalidatePath(`${LISTA}/${slug}`);
      return { ok: true, slug };
    } catch (erro) {
      const t = traduzirErroDoPainel(erro);
      if (t.tipo === "slug-repetido" && i < tentativas) continue;
      return tratar("acervo-salvar-fonte", erro);
    }
  }
  return { ok: false, erros: {}, geral: MENSAGENS.servidor };
}

/** Fonte do arquivo: só os limites e a publicação (o resto é do arquivo versionado). */
export async function salvarFonteDoArquivo(dados: unknown): Promise<ResultadoDeSalvar> {
  const sessao = await exigirAdmin();
  const lido = esquemaFonteDoArquivo.safeParse(dados);
  if (!lido.success) return { ok: false, erros: errosPorCampo(lido.error) };
  const { slug, limites_pt, publicada } = lido.data;
  try {
    await comAdmin(sessao.sessao.id, async (tx) => {
      await tx.execute(
        sql`select acervo.salvar_fonte(${sessao.sessao.id}::uuid, ${JSON.stringify({ modo: "editar", slug, limites_pt, publicada })}::jsonb)`,
      );
    });
    revalidatePath(LISTA);
    revalidatePath(`${LISTA}/${slug}`);
    return { ok: true, slug };
  } catch (erro) {
    return tratar("acervo-salvar-fonte-do-arquivo", erro);
  }
}

/** Resumo e palavras-chave de uma seção (qualquer Fonte que não seja ficha). */
export async function salvarResumoDeSecao(dados: unknown): Promise<ResultadoDeSalvar> {
  const sessao = await exigirAdmin();
  const lido = esquemaResumoDeSecao.safeParse(dados);
  if (!lido.success) return { ok: false, erros: errosPorCampo(lido.error) };
  const { slug, secao, resumo_pt, palavras_chave_pt } = lido.data;
  try {
    await comAdmin(sessao.sessao.id, async (tx) => {
      await tx.execute(
        sql`select acervo.salvar_resumo_secao(${sessao.sessao.id}::uuid, ${`${slug}/${secao}`}, ${resumo_pt}, ${listaDePalavras(palavras_chave_pt)}::text[])`,
      );
    });
    revalidatePath(`${LISTA}/${slug}`);
    return { ok: true, slug };
  } catch (erro) {
    return tratar("acervo-salvar-resumo-de-secao", erro);
  }
}

export type ResultadoDeReverter = { ok: true } | { ok: false; mensagem: string };

/** Devolve ao arquivo os campos que a última carga recusou (`campos` vazio = todos os do conflito). */
export async function reverterAoArquivo(
  slug: unknown,
  campos: unknown,
): Promise<ResultadoDeReverter> {
  const sessao = await exigirAdmin();
  const s = esquemaFonteDoArquivo.shape.slug.safeParse(slug);
  const lista = Array.isArray(campos) && campos.every((c) => typeof c === "string") ? campos : null;
  if (!s.success || lista === null || lista.length > 200)
    return { ok: false, mensagem: MENSAGENS.servidor };
  try {
    await comAdmin(sessao.sessao.id, async (tx) => {
      await tx.execute(
        sql`select acervo.reverter_fonte(${sessao.sessao.id}::uuid, ${s.data}, ${lista.length === 0 ? null : lista}::text[])`,
      );
    });
    revalidatePath(LISTA);
    revalidatePath(`${LISTA}/${s.data}`);
    return { ok: true };
  } catch (erro) {
    const t = traduzirErroDoPainel(erro);
    if (t.tipo === "segundo-fator") redirect(ROTA_SEGUNDO_FATOR);
    registrarErro("acervo-reverter-fonte", erro);
    return { ok: false, mensagem: MENSAGENS.servidor };
  }
}
