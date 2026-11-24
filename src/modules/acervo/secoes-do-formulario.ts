// Linhas de seção do formulário de Fonte do painel e o casamento da resposta do servidor com elas (ACER-08).
//
// CLASSE do defeito achado na revisão cruzada: casar a resposta com as linhas do cliente PELA POSIÇÃO. Se a lista muda
// enquanto o pedido está no ar, a posição de ontem já não é a mesma linha. Aqui cada linha tem um `cid` (id do cliente,
// estável, nunca reaproveitado), o pedido o leva e o servidor o devolve junto com o endereço e a revisão que ele deu; o
// casamento é só por `cid`. Resposta de linha que já não existe é descartada, e linha que não veio na resposta não muda.

export type SecaoEmEdicao = {
  /** Id do cliente, estável durante a vida do formulário. Nunca é gravado no banco. */
  cid: string;
  /** Endereço dado pelo banco; ausente enquanto a seção é nova. */
  slug?: string;
  /** Revisão da seção que o formulário viu pela última vez; ausente enquanto a seção é nova. */
  revisao?: number;
  titulo: string;
  texto: string;
  resumo_pt: string;
  palavras_chave_pt: string;
};

/** O que o servidor devolve por seção enviada: o `cid` que recebeu, o endereço e a revisão depois de salvar. */
export type SecaoSalva = { cid: string; slug: string; revisao: number };

let contador = 0;

/** Um id de cliente novo. Contador, não aleatório: o mesmo no servidor e no navegador não é necessário, só que não repita. */
export function novoCid(): string {
  contador += 1;
  return `c${Date.now().toString(36)}-${contador}`;
}

/** Aplica a resposta às linhas ATUAIS, casando por `cid`. Linhas removidas durante o pedido são ignoradas. */
export function aplicarSalvamento(
  atuais: readonly SecaoEmEdicao[],
  salvas: readonly SecaoSalva[],
): SecaoEmEdicao[] {
  const porCid = new Map(salvas.map((s) => [s.cid, s]));
  return atuais.map((linha) => {
    const salva = porCid.get(linha.cid);
    return salva ? { ...linha, slug: salva.slug, revisao: salva.revisao } : linha;
  });
}
