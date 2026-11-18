import { conferirAmbiente } from "@/db/ambiente";
import { registrarErro } from "@/lib/registro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEM_CACHE = { "Cache-Control": "no-store" };

// Devolve só o rótulo do ambiente do banco, nada além disso. A conferência recusa o par errado.
export async function GET() {
  try {
    const ambiente = await conferirAmbiente();
    return Response.json({ ambiente }, { headers: SEM_CACHE });
  } catch (erro) {
    registrarErro("api-ambiente", erro);
    return Response.json({ erro: "indisponivel" }, { status: 503, headers: SEM_CACHE });
  }
}
