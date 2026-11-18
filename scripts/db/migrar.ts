import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { registrarErro } from "../../src/lib/registro";

// Executor de migrações SQL escritas à mão (db/migrations/NNNN_*.sql), em ordem de nome.
// Conecta como jnf_migra pelo host direto, com trava consultiva e livro admin.migracao.

const PASTA_PADRAO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

// Erro com texto seguro (só nomes de arquivo e de ambiente): pode ir ao terminal.
export class ErroDeMigracao extends Error {}

export type Ambiente = "dev" | "producao";
export type ResultadoMigracao = { aplicadas: string[]; pendentesAntes: number };

const sha256 = (texto: Buffer) => createHash("sha256").update(texto).digest("hex");

export async function executarMigracoes(opcoes: {
  url: string;
  ambiente: Ambiente;
  pasta?: string;
  aviso?: (texto: string) => void;
}): Promise<ResultadoMigracao> {
  const pasta = opcoes.pasta ?? PASTA_PADRAO;
  const aviso = opcoes.aviso ?? ((texto: string) => console.warn(texto));
  const arquivos = readdirSync(pasta)
    .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
    .sort();

  const cliente = new pg.Client({ connectionString: opcoes.url });
  await cliente.connect();
  const aplicadas: string[] = [];
  try {
    await cliente.query("set lock_timeout = '10s'");
    await cliente.query("select pg_advisory_lock(hashtext('jnf-migrar'))");
    try {
      await cliente.query(
        `create table if not exists admin.migracao (
           nome text primary key,
           sha256 text not null,
           aplicada_em timestamptz not null default now()
         )`,
      );

      // O marcador de um banco já marcado nunca é trocado.
      const marcadorExiste = await cliente.query("select to_regclass('acervo.ambiente') as t");
      if (marcadorExiste.rows[0]?.t) {
        const atual = await cliente.query<{ nome: string }>("select nome from acervo.ambiente");
        if (atual.rows[0] && atual.rows[0].nome !== opcoes.ambiente) {
          throw new ErroDeMigracao(
            `Ambiente do banco (${atual.rows[0].nome}) difere do pedido (${opcoes.ambiente})`,
          );
        }
      }

      const livro = await cliente.query<{ nome: string; sha256: string }>(
        "select nome, sha256 from admin.migracao",
      );
      const gravado = new Map(livro.rows.map((linha) => [linha.nome, linha.sha256]));
      const maiorAplicado = [...gravado.keys()].sort().at(-1) ?? "";

      const pendentes: { nome: string; texto: string; hash: string }[] = [];
      for (const nome of arquivos) {
        const bytes = readFileSync(join(pasta, nome));
        const hash = sha256(bytes);
        const anterior = gravado.get(nome);
        if (anterior !== undefined) {
          if (anterior !== hash)
            throw new ErroDeMigracao(`Checksum diferente para migração já aplicada: ${nome}`);
          continue;
        }
        pendentes.push({ nome, texto: bytes.toString("utf8"), hash });
      }

      for (const migracao of pendentes) {
        if (migracao.nome < maiorAplicado) {
          aviso(
            `aviso: ${migracao.nome} tem número menor que a maior migração aplicada (${maiorAplicado})`,
          );
        }
        await cliente.query("begin");
        try {
          await cliente.query(migracao.texto);
          await cliente.query("insert into admin.migracao (nome, sha256) values ($1, $2)", [
            migracao.nome,
            migracao.hash,
          ]);
          await cliente.query("commit");
        } catch (erro) {
          await cliente.query("rollback").catch(() => {});
          throw erro;
        }
        aplicadas.push(migracao.nome);
      }

      const marcador = await cliente.query<{ nome: string }>("select nome from acervo.ambiente");
      if (marcador.rows.length === 0) {
        await cliente.query("insert into acervo.ambiente (nome) values ($1)", [opcoes.ambiente]);
      } else if (marcador.rows[0]?.nome !== opcoes.ambiente) {
        throw new ErroDeMigracao(
          `Ambiente do banco (${marcador.rows[0]?.nome}) difere do pedido (${opcoes.ambiente})`,
        );
      }
      return { aplicadas, pendentesAntes: pendentes.length };
    } finally {
      await cliente.query("select pg_advisory_unlock(hashtext('jnf-migrar'))").catch(() => {});
    }
  } finally {
    await cliente.end().catch(() => {});
  }
}

function lerAmbiente(argumentos: string[]): Ambiente {
  const indice = argumentos.indexOf("--ambiente");
  const valor = indice >= 0 ? argumentos[indice + 1] : undefined;
  if (valor !== "dev" && valor !== "producao") {
    throw new ErroDeMigracao("Uso: db:migrate -- --ambiente <dev|producao>");
  }
  return valor;
}

async function principal(): Promise<void> {
  const ambiente = lerAmbiente(process.argv.slice(2));
  const resultado = await executarMigracoes({
    url: urlDoPapel("migra", { agrupada: false }),
    ambiente,
  });
  if (resultado.aplicadas.length === 0) console.log("migrar: 0 pendentes");
  else
    console.log(
      `migrar: ${resultado.aplicadas.length} aplicada(s): ${resultado.aplicadas.join(", ")}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => {
    // Só o erro nosso mostra texto; o resto vai só com código (a URL é segredo).
    if (erro instanceof ErroDeMigracao) console.error(erro.message);
    else registrarErro("migrar", erro);
    process.exit(1);
  });
}
