import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { obterDb } from "@/db/cliente";

// Limites de tentativa por janela ancorada no primeiro evento, em admin.tentativa (upsert atômico:
// uma linha por chave; a janela vence janelaSegundos depois do primeiro evento e recomeça em 1). A chave nunca guarda
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

// Chave do contador de falhas do código de um endereço (já normalizado).
export const chaveFalhasDoCodigo = (email: string) => chaveDe("codigo-falhas", email);

// Chaves do segundo fator do Admin (por conta). Aqui, sem `server-only`, porque o script de
// recuperação do dono do banco também as apaga.
export const chaveSegundoFatorDaConta = (userId: string) => chaveDe("segundo-fator-conta", userId);
export const chaveDaCriacaoDoSegundoFator = (userId: string) =>
  chaveDe("segundo-fator-criacao", userId);

// O IP vem de cabeçalho que a Vercel define e substitui (x-real-ip, ou x-vercel-forwarded-for).
// Nunca do primeiro valor de x-forwarded-for: esse o cliente consegue enviar.
export function ipDe(cabecalhos: Pick<Headers, "get">): string {
  const real = cabecalhos.get("x-real-ip")?.trim();
  if (real) return real;
  const vercel = cabecalhos.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  return vercel || "sem-ip";
}

// Conta uma tentativa na janela corrente (aberta pelo primeiro evento) e diz se ainda está dentro do máximo.
export async function consumirLimite(
  chave: string,
  maximo: number,
  janelaSegundos: number,
): Promise<{ permitido: boolean; contagem: number }> {
  const resultado = await obterDb().execute<{ contagem: number }>(sql`
    insert into admin.tentativa (chave, janela_inicio, contagem)
    values (${chave}, now(), 1)
    on conflict (chave) do update set
      contagem = case when admin.tentativa.janela_inicio + make_interval(secs => ${janelaSegundos}::int) <= now()
                      then 1 else admin.tentativa.contagem + 1 end,
      janela_inicio = case when admin.tentativa.janela_inicio + make_interval(secs => ${janelaSegundos}::int) <= now()
                           then now() else admin.tentativa.janela_inicio end
    returning contagem`);
  const contagem = Number(resultado.rows[0]?.contagem ?? Number.POSITIVE_INFINITY);
  return { permitido: contagem <= maximo, contagem };
}

// Zera a contagem da própria chave (usada quando um novo acesso é pedido ou a entrada dá certo).
export async function zerarLimite(chave: string): Promise<void> {
  await obterDb().execute(sql`delete from admin.tentativa where chave = ${chave}`);
}

// Reserva um palpite de código ANTES de compará-lo, numa única instrução atômica no banco
// (INSERT … ON CONFLICT DO UPDATE … RETURNING: a linha é travada, então N requisições simultâneas
// recebem contagens distintas). Só quem fica dentro do teto chega à comparação. A reserva vale
// também se o palpite acertar; a entrada bem-sucedida zera a chave (`zerarLimite`).
export async function reservarPalpite(
  chave: string,
): Promise<{ concedido: boolean; contagem: number; ultimo: boolean }> {
  const { maximo, janela } = LIMITES.falhasDoCodigo;
  const { permitido, contagem } = await consumirLimite(chave, maximo, janela);
  return { concedido: permitido, contagem, ultimo: contagem === maximo };
}
