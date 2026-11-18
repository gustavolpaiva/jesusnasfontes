import { envBanco } from "@/lib/env";

export type Papel = "app" | "migra" | "carga" | "assistente";

type Fonte = Record<string, string | undefined>;

const SENHA_DO_PAPEL = {
  app: "JNF_APP_PASSWORD",
  migra: "JNF_MIGRA_PASSWORD",
  carga: "JNF_CARGA_PASSWORD",
  assistente: "JNF_ASSISTENTE_PASSWORD",
} as const;

// Banco local de teste: o host vem com a porta ("127.0.0.1:54331"), não há agrupador nem TLS.
function ehLocal(host: string): boolean {
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

// Host do agrupador do Neon: NEON_POOLER_HOST, ou NEON_HOST com "-pooler" no primeiro rótulo.
function hostAgrupado(host: string, explicito: string | undefined): string {
  if (explicito) return explicito;
  const [primeiro = "", ...resto] = host.split(".");
  return [`${primeiro}-pooler`, ...resto].join(".");
}

// Monta a URL de conexão de um papel. A senha é lida do ambiente e codificada; a URL resultante
// é um segredo: nunca registrar, imprimir nem pôr em mensagem de erro.
export function urlDoPapel(
  papel: Papel,
  opcoes: { agrupada: boolean },
  fonte: Fonte = process.env,
): string {
  const env = envBanco(fonte);
  const senha = env[SENHA_DO_PAPEL[papel]];
  const local = ehLocal(env.NEON_HOST);
  const host =
    !local && opcoes.agrupada ? hostAgrupado(env.NEON_HOST, env.NEON_POOLER_HOST) : env.NEON_HOST;
  const usuario = `jnf_${papel}`;
  const sufixo = local ? "" : "?sslmode=require";
  return `postgres://${usuario}:${encodeURIComponent(senha)}@${host}/${encodeURIComponent(env.NEON_DATABASE)}${sufixo}`;
}
