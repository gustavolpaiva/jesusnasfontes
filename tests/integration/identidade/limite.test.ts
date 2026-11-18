import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { consumirLimite, LIMITES, reservarPalpite, zerarLimite } from "@/modules/identidade/limite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Concorrência contra o Postgres: o teto vale com requisições simultâneas, não só em fila.

const chaves: string[] = [];
const chave = (p: string) => {
  const c = `teste-${p}-${randomBytes(6).toString("hex")}`;
  chaves.push(c);
  return c;
};

async function semear(c: string, n: number) {
  const { janela } = LIMITES.falhasDoCodigo;
  await obterDb().execute(sql`
    insert into admin.tentativa (chave, janela_inicio, contagem)
    values (${c}, to_timestamp(floor(extract(epoch from now()) / ${janela}::int) * ${janela}::int), ${n})`);
}

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  for (const c of chaves) await zerarLimite(c);
  await obterPool().end();
});

describe("reservarPalpite (teto de falhas do código)", () => {
  it("9 falhas semeadas e 5 tentativas simultâneas: só 1 chega à comparação", async () => {
    const c = chave("teto");
    await semear(c, 9);
    const r = await Promise.all(Array.from({ length: 5 }, () => reservarPalpite(c)));
    expect(r.filter((x) => x.concedido)).toHaveLength(1);
    expect(r.filter((x) => x.ultimo)).toHaveLength(1);
    // Contagens distintas: cada requisição recebeu a sua.
    expect(new Set(r.map((x) => x.contagem)).size).toBe(5);
  });

  it("controle positivo: com 0 falhas e 5 simultâneas, as 5 são concedidas", async () => {
    const c = chave("livre");
    const r = await Promise.all(Array.from({ length: 5 }, () => reservarPalpite(c)));
    expect(r.filter((x) => x.concedido)).toHaveLength(5);
  });

  it("depois de zerar (entrada bem-sucedida) volta a conceder", async () => {
    const c = chave("zera");
    await semear(c, 10);
    expect((await reservarPalpite(c)).concedido).toBe(false);
    await zerarLimite(c);
    expect((await reservarPalpite(c)).concedido).toBe(true);
  });
});

describe("consumirLimite (pedidos por e-mail e por IP, código por IP)", () => {
  it("3 por janela e 12 simultâneas: exatamente 3 passam", async () => {
    const c = chave("pedido");
    const r = await Promise.all(Array.from({ length: 12 }, () => consumirLimite(c, 3, 600)));
    expect(r.filter((x) => x.permitido)).toHaveLength(3);
  });
});
