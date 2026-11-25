import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Passo de build de produção (decisão O-3, ramo build-e-editor-sql). Roda ANTES do `next build`, pelo
// script `vercel-build`, e só quando VERCEL_ENV é exatamente "production": Preview e máquina local
// imprimem "pulado" e saem 0, sem ler credencial nem abrir conexão — com uma única exceção, o ensaio em
// Preview (abaixo).
//
// Em produção roda, nesta ordem, os mesmos comandos que existem para uso manual, cada um idempotente:
//   1. migrações (--ambiente producao): trava consultiva, lock_timeout, uma transação por migração,
//      livro com sha256 e o marcador `producao` em acervo.ambiente (sem ele o app recusa toda consulta);
//   2. Bíblia: baixa no commit fixado e confere o sha256 contra o lock ANTES de abrir conexão;
//   3. conteúdo: Estudos, Trilhas, afirmações e perguntas (contagens 8, 30 e 89 conferidas);
//   4. Acervo: carrega as Fontes SÓ dos derivados versionados (`data/acervo-derivados/*.json`), e o
//      carregador confere sha256, bytes e orçamento do lock ANTES de abrir conexão. Sem rede nenhuma: o
//      build não baixa nem deriva nada (CCEL, Gutenberg, GitHub e gospels.net não são contatados, então
//      a produção não falha nem fica lenta quando um deles cai). Atualizar um texto de Fonte é passo de
//      desenvolvedor (`acervo:baixar --fixar`, `acervo:derivar` e o commit do derivado e dos locks);
//   5. Admin inicial (ADMIN_EMAIL_INICIAL), sem enviar e-mail.
// Qualquer falha sai diferente de 0 e o build para: a produção segue na versão anterior. A única
// exceção é o código 3 do passo do Acervo (Fonte recusada porque foi editada no painel, e nada foi
// sobrescrito): vira AVISO impresso, uma linha por conflito, e o build segue. Conflito com a edição do
// painel não pode impedir a produção de receber uma correção de segurança; o painel mostra o conflito.
// A tolerância não vale para nenhum outro código e para nenhum outro passo.
//
// Ensaio em Preview (plano 02-22): com VERCEL_ENV=preview e `JNF_ENSAIO_ACERVO` exatamente "1" (passado por
// `--build-env`), roda SÓ o passo do Acervo, contra o banco de desenvolvimento, a partir dos mesmos
// derivados versionados. Serve para ensaiar a publicação antes do primeiro build de produção; sem a
// variável a Preview continua pulando, e em qualquer outro ambiente o ensaio nunca roda.
//
// O que este passo imprime são só rótulos e o que cada comando já imprime (nenhum imprime segredo).

export type Passo = {
  nome: string;
  script: string;
  argumentos: string[];
  /**
   * Códigos de saída que o build TOLERA neste passo, com aviso impresso, sem parar. Fora desta lista, qualquer
   * código diferente de 0 para o build. Hoje só o passo do Acervo tolera o 3 (conflito com a edição do painel).
   */
  codigosTolerados?: readonly number[];
};

/** O código com que o carregador do Acervo sai quando ao menos uma Fonte foi recusada por edição no painel. */
export const CODIGO_DE_CONFLITO_COM_O_PAINEL = 3;

export const PASSO_DO_ACERVO: Passo = {
  nome: "Acervo",
  script: "scripts/acervo/carregar.ts",
  argumentos: [],
  codigosTolerados: [CODIGO_DE_CONFLITO_COM_O_PAINEL],
};

export const PASSOS: readonly Passo[] = [
  { nome: "migrações", script: "scripts/db/migrar.ts", argumentos: ["--ambiente", "producao"] },
  { nome: "Bíblia", script: "scripts/ingest/biblia-livre.ts", argumentos: [] },
  { nome: "conteúdo", script: "scripts/content/carregar.ts", argumentos: [] },
  PASSO_DO_ACERVO,
  { nome: "Admin inicial", script: "scripts/admin/semear-admin.ts", argumentos: [] },
];

export type Decisao = {
  /** Se este build roda algum passo. Falso: nenhuma credencial é lida e nenhuma conexão é aberta. */
  rodar: boolean;
  /** Os passos que este build roda, na ordem. */
  passos: readonly Passo[];
  mensagem: string;
  /** Modo de ensaio: em Preview, roda SÓ o passo do Acervo contra o banco de desenvolvimento. */
  ensaio: boolean;
};

// Só a string exata "production" liga o passo: variável ausente, vazia ou com outro valor pula.
const pulado = (vercelEnv: string | undefined): string =>
  `passo de produção: pulado (VERCEL_ENV=${vercelEnv === undefined || vercelEnv === "" ? "indefinido" : vercelEnv})`;

/**
 * Decide o que este build roda. Em produção, todos os passos. Em Preview, nada — salvo o ensaio, que exige a
 * variável `JNF_ENSAIO_ACERVO` com o valor EXATO "1": qualquer outro valor (vazio, "true", "01", espaço a mais) pula.
 */
export function decidirPasso(
  vercelEnv: string | undefined,
  ensaioAcervo: string | undefined = undefined,
): Decisao {
  if (vercelEnv === "production")
    return { rodar: true, passos: PASSOS, mensagem: "passo de produção: rodando", ensaio: false };
  if (vercelEnv === "preview" && ensaioAcervo === "1")
    return {
      rodar: true,
      passos: [PASSO_DO_ACERVO],
      mensagem: "passo de ensaio do Acervo: rodando",
      ensaio: true,
    };
  return { rodar: false, passos: [], mensagem: pulado(vercelEnv), ensaio: false };
}

/** As linhas de conflito do carregador do Acervo: a que ele imprime, uma por Fonte recusada por edição no painel. */
export function linhasDeConflito(saida: string): string[] {
  return saida
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith("conflito: "));
}

/** O que o build faz com o código de saída de um passo: segue, segue com aviso (código tolerado) ou para. */
export type DecisaoDoCodigo = { seguir: boolean; avisos: string[] };

export function decidirSobreOCodigo(
  passo: Passo,
  codigo: number | null,
  saida: string,
): DecisaoDoCodigo {
  if (codigo === 0) return { seguir: true, avisos: [] };
  if (codigo !== null && (passo.codigosTolerados ?? []).includes(codigo)) {
    // O aviso é a linha do carregador, uma por conflito: lista a Fonte e os campos em conflito. Se o passo saiu
    // com o código tolerado sem nenhuma linha de conflito, o aviso diz isso, em vez de fingir que não houve nada.
    const conflitos = linhasDeConflito(saida);
    return {
      seguir: true,
      avisos:
        conflitos.length > 0
          ? conflitos
          : [`${passo.nome} saiu com o código ${codigo} sem nenhuma linha de conflito na saída`],
    };
  }
  return { seguir: false, avisos: [] };
}

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

// A saída de um passo que tolera código é guardada até ele acabar (é dela que sai o aviso): 64 MiB bastam para
// qualquer passo, e passar disso para o build em vez de perder o aviso.
const MAXIMO_DE_SAIDA = 64 * 1024 * 1024;

function principal(): number {
  const decisao = decidirPasso(process.env.VERCEL_ENV, process.env.JNF_ENSAIO_ACERVO);
  console.log(decisao.mensagem);
  if (!decisao.rodar) return 0;
  const rotulo = decisao.ensaio ? "ensaio do Acervo" : "produção";

  for (const passo of decisao.passos) {
    // Só o passo que tolera algum código precisa da SAÍDA do filho: é dela que sai o aviso. Os demais seguem
    // ao vivo, como sempre.
    const tolera = (passo.codigosTolerados?.length ?? 0) > 0;
    if (!decisao.ensaio) console.log(`passo de produção: ${passo.nome}`);
    const resultado = spawnSync(
      process.execPath,
      ["--import", "tsx", passo.script, ...passo.argumentos],
      tolera
        ? {
            cwd: RAIZ,
            env: process.env,
            stdio: ["inherit", "pipe", "inherit"],
            encoding: "utf8",
            maxBuffer: MAXIMO_DE_SAIDA,
          }
        : { cwd: RAIZ, env: process.env, stdio: "inherit" },
    );
    // A saída capturada entra no log do build inteira, como entraria ao vivo; só chega no fim do passo.
    if (tolera) process.stdout.write(resultado.stdout ?? "");
    if (resultado.error) {
      console.error(`passo de ${rotulo}: ${passo.nome} não rodou até o fim; o build para`);
      return 1;
    }
    const sobre = decidirSobreOCodigo(
      passo,
      resultado.status,
      typeof resultado.stdout === "string" ? resultado.stdout : "",
    );
    for (const aviso of sobre.avisos)
      console.log(`passo de ${rotulo}: ${passo.nome}: aviso: ${aviso}`);
    if (!sobre.seguir) {
      console.error(`passo de ${rotulo}: ${passo.nome} falhou; o build para`);
      return 1;
    }
  }
  console.log(`passo de ${rotulo}: concluído`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(principal());
}
