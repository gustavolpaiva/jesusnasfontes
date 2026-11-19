import "server-only";
import { waitUntil } from "@vercel/functions";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { esquemaAuth } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import {
  apagarCodigoDe,
  conviteAtivo,
  manterSoCodigoMaisRecente,
} from "@/modules/identidade/convite";
import { normalizarEmail } from "@/modules/identidade/normalizar-email";
import { enviarEmail, modeloEntrada } from "./email";
import { envAuth, urlBase } from "./env";
import { registrarErro } from "./registro";

// Configuração do Better Auth. A entrada é só por convite: o envio de e-mail e a conferência do
// convite acontecem na nossa porta (modules/identidade/entrada.ts); as rotas cruas da biblioteca
// que enviam e-mail estão fechadas em app/api/auth/[...all]/route.ts.

const DIA = 60 * 60 * 24;

function acessos() {
  return [
    magicLink({
      disableSignUp: true,
      expiresIn: 900,
      storeToken: "hashed",
      sendMagicLink: async ({ email, token }) => {
        const emailNorm = normalizarEmail(email);
        // Defesa em profundidade: sem convite ativo, nada é enviado.
        if (!(await conviteAtivo(emailNorm))) return;
        // Um código por endereço: o novo invalida o anterior (só o código; os links ficam).
        await apagarCodigoDe(emailNorm);
        const codigo = await obterAuth().api.createVerificationOTP({
          body: { email: emailNorm, type: "sign-in" },
        });
        await manterSoCodigoMaisRecente(emailNorm);
        // O link do e-mail é o da NOSSA página (que só consome por POST), nunca o da biblioteca.
        const urlConfirmar = `${urlBase()}/entrar/confirmar?token=${encodeURIComponent(token)}`;
        waitUntil(enviarEmail(modeloEntrada({ para: emailNorm, urlConfirmar, codigo })));
      },
    }),
    emailOTP({
      disableSignUp: true,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 3,
      storeOTP: "hashed",
      // Nunca chamado: a rota crua que envia está fechada; o código sai do sendMagicLink.
      sendVerificationOTP: async () => {},
    }),
    twoFactor({ allowPasswordless: true, issuer: "Jesus nas Fontes" }),
  ];
}

function criarAuth() {
  const env = envAuth();
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    // Nada que a biblioteca queira imprimir sai como veio: o erro de uma consulta traz os parâmetros
    // (token de sessão, código, e-mail). Todo registro dela passa por `registrarErro`, que grava só
    // rótulo e código; a mensagem entra apenas se for uma constante em maiúsculas (ex.:
    // INTERNAL_SERVER_ERROR). `onAPIError.onError` substitui o registro padrão dos erros de rota.
    logger: {
      log: (nivel, mensagem, ...resto) => {
        const rotulo = /^[A-Z_]{3,48}$/.test(String(mensagem)) ? `:${String(mensagem)}` : "";
        const comCodigo = resto.find(
          (r) => typeof (r as { code?: unknown } | null)?.code === "string",
        );
        registrarErro(`better-auth-${nivel}${rotulo}`, comCodigo);
      },
    },
    onAPIError: { onError: (erro) => registrarErro("better-auth-rota", erro) },
    telemetry: { enabled: false },
    baseURL: urlBase(),
    trustedOrigins: [urlBase()],
    database: drizzleAdapter(obterDb(), { provider: "pg", schema: esquemaAuth }),
    advanced: {
      database: { generateId: "uuid" },
      // Cabeçalhos que a Vercel define; o primeiro valor de x-forwarded-for o cliente consegue enviar.
      ipAddress: { ipAddressHeaders: ["x-real-ip", "x-vercel-forwarded-for"] },
    },
    session: { expiresIn: 30 * DIA, updateAge: DIA },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    user: {
      deleteUser: { enabled: true },
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "estudante", input: false },
      },
    },
    // nextCookies precisa ser o último plugin.
    // Primeira linha: sem convite ativo a sessão nem chega a ser criada (o gancho aborta a criação).
    // Assim nada é desfeito depois com base no navegador de quem fez a requisição.
    databaseHooks: {
      session: {
        create: {
          before: async (sessao) => {
            const dono = await obterDb()
              .select({ email: usuario.email })
              .from(usuario)
              .where(eq(usuario.id, sessao.userId))
              .limit(1);
            const email = dono[0]?.email;
            return email !== undefined && (await conviteAtivo(email));
          },
        },
      },
    },
    plugins: [...acessos(), nextCookies()],
  });
}

type Auth = ReturnType<typeof criarAuth>;

// Criado na primeira chamada: importar este módulo não exige variáveis de ambiente.
let instancia: Auth | undefined;
export function obterAuth(): Auth {
  instancia ??= criarAuth();
  return instancia;
}
