import { z } from "zod";

// Contrato das variáveis de ambiente. Os leitores são preguiçosos: cada área só valida o que usa,
// no momento em que é chamada. Quem precisa de uma variável chama a função da área; nenhum outro
// arquivo lê `process.env` diretamente. Este módulo não importa `server-only` porque os scripts
// executados com tsx também o usam.

type Fonte = Record<string, string | undefined>;

// Texto vazio equivale a variável ausente.
function semVazios(fonte: Fonte): Fonte {
  return Object.fromEntries(Object.entries(fonte).filter(([, valor]) => valor !== ""));
}

// O erro lista só os NOMES das variáveis com problema, nunca valores.
function ler<T extends z.ZodType>(area: string, esquema: T, fonte: Fonte): z.infer<T> {
  const resultado = esquema.safeParse(semVazios(fonte));
  if (!resultado.success) {
    const nomes = [...new Set(resultado.error.issues.map((item) => String(item.path[0] ?? "?")))];
    throw new Error(`Variáveis de ambiente ausentes ou inválidas (${area}): ${nomes.join(", ")}`);
  }
  return resultado.data;
}

const texto = z.string().min(1);

const esquemaBanco = z.object({
  NEON_HOST: texto,
  NEON_POOLER_HOST: texto.optional(),
  NEON_DATABASE: texto,
  JNF_APP_PASSWORD: texto,
  JNF_MIGRA_PASSWORD: texto,
  JNF_CARGA_PASSWORD: texto,
  JNF_ASSISTENTE_PASSWORD: texto,
  PGSSLMODE: texto.optional(),
});

export function envBanco(fonte: Fonte = process.env) {
  return ler("banco", esquemaBanco, fonte);
}

const esquemaBootstrap = z.object({ DATABASE_URL_OWNER: texto });

export function envBootstrap(fonte: Fonte = process.env) {
  return ler("bootstrap", esquemaBootstrap, fonte);
}

const esquemaAuth = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_URL: z.url().optional(),
});

export function envAuth(fonte: Fonte = process.env) {
  return ler("autenticação", esquemaAuth, fonte);
}

const esquemaEmail = z
  .object({
    MAIL_TRANSPORT: z.enum(["arquivo", "resend"]).optional(),
    MAIL_DIR: texto.optional(),
    RESEND_API_KEY: texto.optional(),
    EMAIL_FROM: texto.optional(),
  })
  .superRefine((valores, contexto) => {
    // O transporte padrão é decidido pelo chamador, que conhece o ambiente (ver envEmail).
    if (valores.MAIL_TRANSPORT === "resend") {
      for (const nome of ["RESEND_API_KEY", "EMAIL_FROM"] as const) {
        if (!valores[nome]) contexto.addIssue({ code: "custom", path: [nome], message: "ausente" });
      }
    }
  });

export function envEmail(fonte: Fonte = process.env) {
  // Na Vercel (variável VERCEL presente) o padrão é enviar de verdade; fora dela, gravar em arquivo.
  const padrao = fonte.VERCEL ? "resend" : "arquivo";
  const entrada = semVazios(fonte);
  const bruto = { ...entrada, MAIL_TRANSPORT: entrada.MAIL_TRANSPORT ?? padrao };
  const dados = ler("e-mail", esquemaEmail, bruto);
  return {
    ...dados,
    MAIL_TRANSPORT: dados.MAIL_TRANSPORT ?? padrao,
    MAIL_DIR: dados.MAIL_DIR ?? "test-results/correio",
  };
}

const esquemaAdmin = z.object({ ADMIN_EMAIL_INICIAL: z.email() });

export function envAdmin(fonte: Fonte = process.env) {
  return ler("admin", esquemaAdmin, fonte);
}

const esquemaAviso = z.object({ AVISO_RESPONSAVEL: texto, AVISO_CONTATO: texto });

export function envAviso(fonte: Fonte = process.env) {
  return ler("aviso de privacidade", esquemaAviso, fonte);
}

const esquemaTeste = z.object({
  ALVO_BANCO: z.enum(["local", "neon"]).default("local"),
  PORTA_E2E: z.coerce.number().int().min(1).max(65535).optional(),
  NEXT_DIST_DIR: texto.optional(),
});

export function envTeste(fonte: Fonte = process.env) {
  return ler("teste", esquemaTeste, fonte);
}

// Endereço público da aplicação: APP_URL; senão o endereço da Vercel; senão o local.
export function urlBase(fonte: Fonte = process.env): string {
  const entrada = semVazios(fonte);
  if (entrada.APP_URL) return entrada.APP_URL.replace(/\/+$/, "");
  if (entrada.VERCEL_URL) return `https://${entrada.VERCEL_URL}`;
  const porta = entrada.PORTA_E2E ?? entrada.PORT ?? "3000";
  return `http://localhost:${porta}`;
}
