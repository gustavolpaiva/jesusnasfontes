import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Passo de build de produção (decisão O-3, ramo build-e-editor-sql). Roda ANTES do `next build`, pelo
// script `vercel-build`, e só quando VERCEL_ENV é exatamente "production": Preview e máquina local
// imprimem "pulado" e saem 0, sem ler credencial nem abrir conexão.
//
// Em produção roda, nesta ordem, os mesmos comandos que existem para uso manual, cada um idempotente:
//   1. migrações (--ambiente producao): trava consultiva, lock_timeout, uma transação por migração,
//      livro com sha256 e o marcador `producao` em acervo.ambiente (sem ele o app recusa toda consulta);
//   2. Bíblia: baixa no commit fixado e confere o sha256 contra o lock ANTES de abrir conexão;
//   3. conteúdo: Estudos, Trilhas, afirmações e perguntas (contagens 8, 30 e 89 conferidas);
//   4. Admin inicial (ADMIN_EMAIL_INICIAL), sem enviar e-mail.
// Qualquer falha sai diferente de 0 e o build para: a produção segue na versão anterior.
// O que este passo imprime são só rótulos e o que cada comando já imprime (nenhum imprime segredo).

export type Passo = { nome: string; script: string; argumentos: string[] };

export const PASSOS: readonly Passo[] = [
  { nome: "migrações", script: "scripts/db/migrar.ts", argumentos: ["--ambiente", "producao"] },
  { nome: "Bíblia", script: "scripts/ingest/biblia-livre.ts", argumentos: [] },
  { nome: "conteúdo", script: "scripts/content/carregar.ts", argumentos: [] },
  { nome: "Admin inicial", script: "scripts/admin/semear-admin.ts", argumentos: [] },
];

// Só a string exata "production" liga o passo: variável ausente, vazia ou com outro valor pula.
export function decidirPasso(vercelEnv: string | undefined): { rodar: boolean; mensagem: string } {
  if (vercelEnv === "production") return { rodar: true, mensagem: "passo de produção: rodando" };
  return {
    rodar: false,
    mensagem: `passo de produção: pulado (VERCEL_ENV=${vercelEnv === undefined || vercelEnv === "" ? "indefinido" : vercelEnv})`,
  };
}

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

function principal(): number {
  const decisao = decidirPasso(process.env.VERCEL_ENV);
  console.log(decisao.mensagem);
  if (!decisao.rodar) return 0;

  for (const passo of PASSOS) {
    console.log(`passo de produção: ${passo.nome}`);
    const resultado = spawnSync(
      process.execPath,
      ["--import", "tsx", passo.script, ...passo.argumentos],
      { cwd: RAIZ, stdio: "inherit", env: process.env },
    );
    if (resultado.status !== 0) {
      console.error(`passo de produção: ${passo.nome} falhou; o build para`);
      return 1;
    }
  }
  console.log("passo de produção: concluído");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(principal());
}
