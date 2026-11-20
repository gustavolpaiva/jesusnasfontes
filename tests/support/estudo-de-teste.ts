import { createHash } from "node:crypto";
import pg from "pg";
import { urlDoPapel } from "../../src/db/url";

// Um Estudo FIXO no banco compartilhado dos testes de integração. Desde a migração 0013, `privado.anotacao`
// tem chave estrangeira para `conteudo.estudo`: os testes que gravam uma Anotação numa conta de teste do
// banco compartilhado precisam de um Estudo de verdade. Ele nasce uma vez, no `setup` global (nunca por
// arquivo de teste), para nenhum arquivo criar ou apagar Estudos durante a janela em que outro os conta
// (a causa da instabilidade de `carga.test.ts` que o plano 01-14 já tinha achado).

export const ESTUDO_DE_TESTE = {
  trilha: "trilha-teste-anotacao",
  id: "5f1c7a52-0000-4000-8000-00000000a707",
  slug: "estudo-teste-anotacao",
};

export async function semearEstudoDeTeste(env: Record<string, string>): Promise<void> {
  const cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, env),
  });
  await cliente.connect();
  try {
    // A ordem 98 não colide com as Trilhas reais (1 a 3) nem com as dos testes (9 e 99).
    await cliente.query(
      `insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, 'Trilha de teste', 98, 'x')
       on conflict (id) do nothing`,
      [ESTUDO_DE_TESTE.trilha],
    );
    await cliente.query(
      `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
       values ($1, $2, $3, 1, 'Estudo de teste', 'devocional', 'x', $4)
       on conflict (id) do nothing`,
      [
        ESTUDO_DE_TESTE.id,
        ESTUDO_DE_TESTE.slug,
        ESTUDO_DE_TESTE.trilha,
        createHash("sha256").update(ESTUDO_DE_TESTE.id).digest("hex"),
      ],
    );
  } finally {
    await cliente.end();
  }
}
