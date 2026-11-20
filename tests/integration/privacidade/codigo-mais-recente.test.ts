import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { verificacao } from "@/db/schema/entrada";
import { manterSoVerificacaoMaisRecente } from "@/modules/identidade/convite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// Depois de um palpite errado que cruzou com um pedido novo, a biblioteca deixa o código antigo ao lado
// do novo. A regra: de cada identificador, só o que vence por último fica; o vizinho não é tocado.

const emNeon = () => inject("alvoBanco") === "neon";
const rodada = randomUUID();
const meu = `email-verification-otp-a-${rodada}@example.test`;
const vizinho = `email-verification-otp-b-${rodada}@example.test`;
const em = (min: number) => new Date(Date.now() + min * 60_000);

beforeAll(() => {
  aplicarEnvDeTeste();
});

afterAll(async () => {
  if (!emNeon()) {
    await obterDb()
      .delete(verificacao)
      .where(inArray(verificacao.identifier, [meu, vizinho]));
  }
  await obterPool().end();
});

describe.skipIf(emNeon())("manterSoVerificacaoMaisRecente", () => {
  it("apaga o código antigo restaurado, fica o mais recente, e o de outra conta fica como estava", async () => {
    await obterDb()
      .insert(verificacao)
      .values([
        { id: randomUUID(), identifier: meu, value: "antigo", expiresAt: em(3) },
        { id: randomUUID(), identifier: meu, value: "novo", expiresAt: em(5) },
        { id: randomUUID(), identifier: vizinho, value: "v-antigo", expiresAt: em(1) },
        { id: randomUUID(), identifier: vizinho, value: "v-novo", expiresAt: em(9) },
      ]);
    await manterSoVerificacaoMaisRecente(meu);
    const meus = await obterDb()
      .select({ value: verificacao.value })
      .from(verificacao)
      .where(eq(verificacao.identifier, meu));
    expect(meus.map((l) => l.value)).toEqual(["novo"]);
    // Controle negativo: o vizinho segue com as duas linhas.
    const dele = await obterDb()
      .select({ value: verificacao.value })
      .from(verificacao)
      .where(eq(verificacao.identifier, vizinho));
    expect(dele.map((l) => l.value).sort()).toEqual(["v-antigo", "v-novo"]);
  });
});
