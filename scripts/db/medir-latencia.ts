import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { registrarErro } from "../../src/lib/registro";

// Mede, como jnf_app pela URL agrupada, a primeira consulta de um processo novo e cinco seguintes.
// Imprime só milissegundos e a versão do servidor.

async function principal(): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: true }) });
  const ms = (inicio: number) => Math.round(performance.now() - inicio);
  const inicio = performance.now();
  await cliente.connect();
  const conexao = ms(inicio);
  const primeira = performance.now();
  await cliente.query("select 1");
  const primeiraConsulta = ms(primeira);
  const seguintes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await cliente.query("select 1");
    seguintes.push(ms(t));
  }
  const versao = await cliente.query("show server_version");
  await cliente.end();
  console.log(
    JSON.stringify({
      conexao_ms: conexao,
      primeira_consulta_ms: primeiraConsulta,
      cinco_seguintes_ms: seguintes,
      server_version: versao.rows[0]?.server_version,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => {
    registrarErro("medir-latencia", erro);
    process.exit(1);
  });
}
