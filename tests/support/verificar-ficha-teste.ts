import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { criarSessaoDeTeste } from "./sessao-admin-banco";

// Verifica uma ficha já carregada como rascunho, SEMPRE pelas funções reais do banco (`acervo.conferir_item` e
// `acervo.verificar_ficha`, migração 0020), com uma sessão de Admin com segundo fator semeada para isto. Nunca insere
// direto nas tabelas de evidência: o que o teste vê é o que a produção produz. Só para banco descartável local
// (a semeadura da sessão usa a conexão do dono do cluster, `DATABASE_URL_OWNER` do ambiente preparado).
//
// `env` é o ambiente que `criarBancoPreparado` devolve (o mesmo que os testes aplicam a `process.env`).

export type FichaVerificadaParaTeste = {
  fichaId: string;
  hash: string;
  itens: string[];
  sessaoId: string;
};

export async function verificarFichaParaTeste(
  env: Record<string, string | undefined>,
  slugDaFicha: string,
): Promise<FichaVerificadaParaTeste> {
  const urlDoDono = env.DATABASE_URL_OWNER;
  if (!urlDoDono) throw new Error("verificarFichaParaTeste: ambiente sem DATABASE_URL_OWNER");
  const dono = new pg.Client({ connectionString: urlDoDono });
  const app = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: false }, env) });
  await dono.connect();
  try {
    await app.connect();
    const { sessaoId } = await criarSessaoDeTeste(dono, "admin-com-segundo-fator");

    const ficha = await dono.query<{ fonte_id: string; conteudo_hash: string }>(
      `select f.fonte_id, f.conteudo_hash
         from acervo.ficha f join acervo.fonte o on o.id = f.fonte_id where o.slug = $1`,
      [slugDaFicha],
    );
    const linha = ficha.rows[0];
    if (!linha) throw new Error(`verificarFichaParaTeste: ficha "${slugDaFicha}" não encontrada`);

    const itens = await dono.query<{ id: string; conteudo_hash: string }>(
      `select id, conteudo_hash from acervo.ficha_item
        where ficha_id = $1 and (pagina_inicio is not null or pagina_texto is not null)
        order by tipo, ordem`,
      [linha.fonte_id],
    );
    for (const item of itens.rows) {
      await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
        sessaoId,
        item.id,
        item.conteudo_hash,
      ]);
    }
    await app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
      sessaoId,
      linha.fonte_id,
      linha.conteudo_hash,
    ]);
    return {
      fichaId: linha.fonte_id,
      hash: linha.conteudo_hash,
      itens: itens.rows.map((i) => i.id),
      sessaoId,
    };
  } finally {
    await app.end().catch(() => {});
    await dono.end().catch(() => {});
  }
}
