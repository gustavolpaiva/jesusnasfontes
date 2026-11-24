import { eq, sql } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import { ErroDeBanco } from "@/db/erro-banco";
import { conferenciaItem, ficha, fichaItem, verificacaoFicha } from "@/db/schema/acervo-ficha";
import { ConteudoMudou, EdicaoNaoConfirmada, FaltamPaginas, SegundoFatorVencido } from "./erros";

// As duas únicas portas que gravam evidência de verificação (ACER-07, D-02, D-03). Cada uma chama uma função do banco
// (`acervo.conferir_item`, `acervo.verificar_ficha`, migração 0020) que reexige a sessão de um Admin com segundo fator;
// o banco decide, esta camada só traduz o código do erro. NÃO há diretiva de Server Action neste arquivo de propósito:
// nada daqui pode ser chamado pelo navegador. As Server Actions do painel (plano 18) é que o importam, depois de
// provar o Admin pela sessão.
//
// Não existe função de desfazer: corrigir uma ficha verificada é editar o arquivo e recarregar (o hash muda e a
// verificação deixa de valer sozinha).

const CONTAGEM_DAS_PAGINAS = /^faltam_(\d{1,9})$/;

/** Traduz o SQLSTATE das funções de verificação em erro tipado; qualquer outro erro sobe como veio (já sanitizado). */
export function traduzirErroDeVerificacao(erro: unknown): unknown {
  if (!(erro instanceof ErroDeBanco)) return erro;
  switch (erro.code) {
    case "42501":
      return new SegundoFatorVencido();
    case "40001":
      return new ConteudoMudou();
    case "P0002":
      return new EdicaoNaoConfirmada();
    case "P0001": {
      // A contagem viaja no nome da restrição (`faltam_<n>`): é o único campo, além do código, que a camada de banco
      // deixa passar. Sem contagem legível, o erro sobe como veio.
      const contagem = CONTAGEM_DAS_PAGINAS.exec(erro.constraint ?? "");
      return contagem ? new FaltamPaginas(Number(contagem[1])) : erro;
    }
    default:
      return erro;
  }
}

/** O Admin conferiu esta página no livro, para o hash do item que ele viu. */
export async function conferirItem(sessaoId: string, itemId: string, hash: string): Promise<void> {
  try {
    await comAdmin(sessaoId, async (tx) => {
      await tx.execute(sql`select acervo.conferir_item(${sessaoId}::uuid, ${itemId}, ${hash})`);
    });
  } catch (erro) {
    throw traduzirErroDeVerificacao(erro);
  }
}

/** O Admin verificou a ficha, para o hash da ficha que ele viu. O hash gravado é o que o banco calculou. */
export async function verificarFicha(
  sessaoId: string,
  fichaId: string,
  hash: string,
): Promise<void> {
  try {
    await comAdmin(sessaoId, async (tx) => {
      await tx.execute(
        sql`select acervo.verificar_ficha(${sessaoId}::uuid, ${fichaId}::uuid, ${hash})`,
      );
    });
  } catch (erro) {
    throw traduzirErroDeVerificacao(erro);
  }
}

/**
 * O que o painel (plano 02-18) usa: confere o item SÓ se a conferência do hash que o Admin viu ainda não existe. Uma
 * segunda aba que confere o mesmo item não regrava nada (a data da primeira conferência continua valendo). Devolve
 * `true` se gravou, `false` se já estava conferido para este hash. A recusa de hash velho (40001) continua sendo do
 * banco, que trava o item.
 */
export async function conferirItemUmaVez(
  sessaoId: string,
  itemId: string,
  hash: string,
): Promise<boolean> {
  try {
    return await comAdmin(sessaoId, async (tx) => {
      // Só "já conferido" se a conferência é do hash que o Admin viu E esse ainda é o hash do item: hash velho vai ao
      // banco, que o recusa (40001).
      const ja = await tx
        .select({ itemHash: conferenciaItem.itemHash, atual: fichaItem.conteudoHash })
        .from(conferenciaItem)
        .innerJoin(fichaItem, eq(fichaItem.id, conferenciaItem.itemId))
        .where(eq(conferenciaItem.itemId, itemId));
      if (ja[0]?.itemHash === hash && ja[0].atual === hash) return false;
      await tx.execute(sql`select acervo.conferir_item(${sessaoId}::uuid, ${itemId}, ${hash})`);
      return true;
    });
  } catch (erro) {
    throw traduzirErroDeVerificacao(erro);
  }
}

export type ResultadoDeVerificarUmaVez =
  | { gravou: true; verificadaEm: Date }
  | { gravou: false; verificadaEm: Date };

/**
 * Verifica a ficha SÓ se ela ainda não está verificada para o hash que o Admin viu. Uma segunda aba que verifica a mesma
 * ficha recebe `gravou: false` com a data da primeira, e nada é regravado. O hash velho (40001), as páginas faltantes
 * (P0001), a edição "A confirmar" (P0002) e o segundo fator vencido (42501) continuam sendo decisão do banco.
 */
export async function verificarFichaUmaVez(
  sessaoId: string,
  fichaId: string,
  hash: string,
): Promise<ResultadoDeVerificarUmaVez> {
  try {
    return await comAdmin(sessaoId, async (tx) => {
      // "Já verificada" só vale se a verificação é do hash que o Admin viu E esse ainda é o hash da ficha: hash velho
      // vai ao banco, que o recusa (40001).
      const ja = await tx
        .select({
          fichaHash: verificacaoFicha.fichaHash,
          verificadaEm: verificacaoFicha.verificadaEm,
          atual: ficha.conteudoHash,
        })
        .from(verificacaoFicha)
        .innerJoin(ficha, eq(ficha.fonteId, verificacaoFicha.fichaId))
        .where(eq(verificacaoFicha.fichaId, fichaId));
      if (ja[0]?.fichaHash === hash && ja[0].atual === hash)
        return { gravou: false, verificadaEm: ja[0].verificadaEm };
      await tx.execute(
        sql`select acervo.verificar_ficha(${sessaoId}::uuid, ${fichaId}::uuid, ${hash})`,
      );
      const agora = await tx
        .select({ verificadaEm: verificacaoFicha.verificadaEm })
        .from(verificacaoFicha)
        .where(eq(verificacaoFicha.fichaId, fichaId));
      return { gravou: true, verificadaEm: agora[0]?.verificadaEm ?? new Date() };
    });
  } catch (erro) {
    throw traduzirErroDeVerificacao(erro);
  }
}
