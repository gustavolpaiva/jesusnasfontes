import "server-only";
import { waitUntil } from "@vercel/functions";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink, twoFactor } from "better-auth/plugins";
import { obterDb } from "@/db/cliente";
import { esquemaAuth } from "@/db/schema/entrada";
import { conviteAtivo } from "@/modules/identidade/convite";
import { normalizarEmail } from "@/modules/identidade/normalizar-email";
import { enviarEmail, modeloEntrada } from "./email";
import { envAuth, urlBase } from "./env";

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
        const codigo = await obterAuth().api.createVerificationOTP({
          body: { email: emailNorm, type: "sign-in" },
        });
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
