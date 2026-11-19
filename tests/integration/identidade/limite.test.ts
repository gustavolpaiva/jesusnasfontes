import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { consumirLimite, reservarPalpite, zerarLimite } from "@/modules/identidade/limite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Concorrência contra o Postgres: o teto vale com requisições simultâneas, não só em fila.

const chaves: string[] = [];
const chave = (p: string) => {
  const c = `teste-${p}-${randomBytes(6).toString("hex")}`;
  chaves.push(c);
  return c;
};

// Semeia a linha da chave com a janela aberta há `idadeSegundos` (instante controlado, sem sleep).
async function semear(c: string, n: number, idadeSegundos = 0) {
  await obterDb().execute(sql`
    insert into admin.tentativa (chave, janela_inicio, contagem)
    values (${c}, now() - make_interval(secs => ${idadeSegundos}::int), ${n})`);
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

  // Janela ancorada no primeiro evento: não há virada de bloco compartilhada. Com o bloco fixo do
  // relógio, a linha semeada (aberta há 1 s, fora do alinhamento do bloco) não seria a da chave
  // corrente, e o pedido passaria; a mutação de voltar ao bloco fixo derruba estes testes.
  it("janela aberta há 1 s com o teto cheio: o pedido seguinte NÃO passa", async () => {
    const c = chave("quase-virada");
    await semear(c, 3, 1);
    expect((await consumirLimite(c, 3, 600)).permitido).toBe(false);
    expect((await consumirLimite(c, 3, 600)).permitido).toBe(false);
  });

  it("janela prestes a vencer (1 s antes): ainda bloqueia; 1 s depois: reabre em 1", async () => {
    const antes = chave("antes");
    await semear(antes, 3, 599);
    expect((await consumirLimite(antes, 3, 600)).permitido).toBe(false);
    const depois = chave("depois");
    await semear(depois, 3, 601);
    const r = await consumirLimite(depois, 3, 600);
    expect(r).toEqual({ permitido: true, contagem: 1 });
    // A nova janela nasce agora: 3 passam no total, o 4º não.
    expect((await consumirLimite(depois, 3, 600)).permitido).toBe(true);
    expect((await consumirLimite(depois, 3, 600)).permitido).toBe(true);
    expect((await consumirLimite(depois, 3, 600)).permitido).toBe(false);
  });

  it("início logo antes do que seria a virada do bloco fixo: a janela ancorada segue valendo", async () => {
    // Semeia a linha 1 s antes do início do bloco corrente de 24 h do relógio (o ponto de virada de
    // uma janela fixa). Ancorada, a janela tem 1 s + o que passou do bloco: só vence se esse tempo
    // chegar a 24 h, o que não ocorre fora do último segundo do dia. Um bloco fixo reabriria aqui.
    const c = chave("virada");
    await obterDb().execute(sql`
      insert into admin.tentativa (chave, janela_inicio, contagem)
      values (${c}, to_timestamp(floor(extract(epoch from now()) / 86400) * 86400) - interval '1 second', 3)`);
    expect((await consumirLimite(c, 3, 86400)).permitido).toBe(false);
  });

  it("palpites: 10 usados há 1 s não dobram na virada (sem 20 seguidos)", async () => {
    const c = chave("palpites");
    await semear(c, 10, 1);
    const r = await Promise.all(Array.from({ length: 10 }, () => reservarPalpite(c)));
    expect(r.filter((x) => x.concedido)).toHaveLength(0);
  });
});
