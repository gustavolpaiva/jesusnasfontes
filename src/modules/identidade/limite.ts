import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";

// Limites de tentativa por janela fixa, em admin.tentativa (upsert atômico). A chave nunca guarda
// o endereço nem o IP em claro: só um resumo.

export const LIMITES = {
  pedidoPorIp: { maximo: 5, janela: 60 },
  pedidoPorEmail: { maximo: 3, janela: 600 },
  codigoPorIp: { maximo: 10, janela: 600 },
  // Teto acumulado por endereço, que pedido novo NÃO zera (só entrada bem-sucedida ou o fim da
  // janela): 10 palpites por dia contra um código de 6 dígitos.
  falhasDoCodigo: { maximo: 10, janela: 86400 },
} as const;

export function chaveDe(prefixo: string, valor: string): string {
  return `${prefixo}:${createHash("sha256").update(valor).digest("hex").slice(0, 32)}`;
}

// O IP vem de cabeçalho que a Vercel define e substitui (x-real-ip, ou x-vercel-forwarded-for).
// Nunca do primeiro valor de x-forwarded-for: esse o cliente consegue enviar.
export function ipDe(cabecalhos: Pick<Headers, "get">): string {
  const real = cabecalhos.get("x-real-ip")?.trim();
  if (real) return real;
  const vercel = cabecalhos.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  return vercel || "sem-ip";
}

// Conta uma tentativa na janela corrente e diz se ainda está dentro do máximo.
export async function consumirLimite(
  chave: string,
  maximo: number,
  janelaSegundos: number,
): Promise<{ permitido: boolean; contagem: number }> {
  const resultado = await obterDb().execute<{ contagem: number }>(sql`
    insert into admin.tentativa (chave, janela_inicio, contagem)
    values (${chave}, to_timestamp(floor(extract(epoch from now()) / ${janelaSegundos}::int) * ${janelaSegundos}::int), 1)
    on conflict (chave, janela_inicio) do update set contagem = admin.tentativa.contagem + 1
    returning contagem`);
  const contagem = Number(resultado.rows[0]?.contagem ?? Number.POSITIVE_INFINITY);
  return { permitido: contagem <= maximo, contagem };
}

// Quantas tentativas já houve na janela corrente, sem contar mais uma.
export async function lerContagem(chave: string, janelaSegundos: number): Promise<number> {
  const resultado = await obterDb().execute<{ contagem: number }>(sql`
    select contagem from admin.tentativa
    where chave = ${chave}
      and janela_inicio = to_timestamp(floor(extract(epoch from now()) / ${janelaSegundos}::int) * ${janelaSegundos}::int)`);
  return Number(resultado.rows[0]?.contagem ?? 0);
}

// Zera a contagem da própria chave (usada quando um novo acesso é pedido ou a entrada dá certo).
export async function zerarLimite(chave: string): Promise<void> {
  await obterDb().execute(sql`delete from admin.tentativa where chave = ${chave}`);
}
