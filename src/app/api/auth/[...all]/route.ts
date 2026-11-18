import { toNextJsHandler } from "better-auth/next-js";
import { obterAuth } from "@/lib/auth";

// Lista de permissão: só a leitura da sessão e a saída passam pelo manipulador da biblioteca.
// As rotas cruas que enviam e-mail ou entram (magic-link, email-otp) respondem 404: a entrada só
// existe pela nossa porta (Server Actions), que confere o convite antes de qualquer envio.
const PERMITIDAS = new Set(["GET /api/auth/get-session", "POST /api/auth/sign-out"]);

function permitida(requisicao: Request): boolean {
  const { pathname } = new URL(requisicao.url);
  return PERMITIDAS.has(`${requisicao.method} ${pathname}`);
}

const naoEncontrado = () => new Response("Not Found", { status: 404 });

export async function GET(requisicao: Request) {
  if (!permitida(requisicao)) return naoEncontrado();
  return toNextJsHandler(obterAuth()).GET(requisicao);
}

export async function POST(requisicao: Request) {
  if (!permitida(requisicao)) return naoEncontrado();
  return toNextJsHandler(obterAuth()).POST(requisicao);
}
