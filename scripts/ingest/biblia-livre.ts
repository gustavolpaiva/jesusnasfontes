// pnpm ingest:biblia — verifica (sha256 de cada arquivo contra o lock, ANTES de interpretar; validação
// com o esperado), e carrega as duas edições da Bíblia Livre no banco como jnf_carga. Reprodutível:
// uma segunda execução imprime inseridos=0 alterados=0 nas duas edições. Arquivo adulterado aborta
// antes de abrir conexão com o banco.

import { pathToFileURL } from "node:url";
import { registrarErro } from "../../src/lib/registro";
import {
  abrirCarga,
  carregarEdicao,
  conjuntoDoRegistro,
  ErroCarga,
  lerEdicoesVerificadas,
} from "./carregar-biblia";
import { verificar } from "./verificar";

export async function ingerir(): Promise<string[]> {
  // 1) O mesmo caminho do `ingest:verify`, inteiro, antes de qualquer conexão.
  const verificacao = await verificar();
  // 2) A leitura que alimenta a carga é a mesma e tem de dar exatamente o que a verificação viu.
  const leitura = await lerEdicoesVerificadas();
  if (leitura.impressao !== verificacao.impressao)
    throw new ErroCarga(
      "o que vai ao banco difere do que a verificação interpretou: nada foi escrito",
    );
  const esperado = leitura.registro.esperado;
  if (!esperado) throw new ErroCarga("datasets.yaml sem esperado");
  const conjunto = conjuntoDoRegistro(leitura.registro, leitura.sha256Lock);

  const saida: string[] = [];
  const cliente = await abrirCarga();
  try {
    for (const e of leitura.edicoes) {
      const r = await carregarEdicao(e.versiculos, {
        edicao: e.edicao,
        conjunto,
        marcadores: e.marcadores,
        mesclados: e.mesclados,
        totalEsperado: esperado.versiculos,
        cliente,
      });
      saida.push(
        `edicao=${e.edicao} inseridos=${r.inseridos} alterados=${r.alterados} inalterados=${r.inalterados}`,
      );
    }
  } finally {
    await cliente.end().catch(() => {});
  }
  return saida;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inicio = Date.now();
  ingerir()
    .then((linhas) => {
      for (const l of linhas) console.log(l);
      console.log(`duracao_ms=${Date.now() - inicio}`);
    })
    .catch((erro: unknown) => {
      // Só erro nosso mostra texto; o resto vai só com código e classe (a URL do banco é segredo).
      if (
        erro instanceof ErroCarga ||
        (erro instanceof Error && ["ErroValidacao", "ErroChecksum", "ErroF4"].includes(erro.name))
      )
        console.error(erro.message);
      else registrarErro("ingest-biblia", erro);
      process.exit(1);
    });
}
