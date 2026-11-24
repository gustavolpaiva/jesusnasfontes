import { sql } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import { ErroDeBanco } from "@/db/erro-banco";
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
