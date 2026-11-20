import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { anotacao, usuario } from "@/db/schema/fundacao";
import { registrarErro } from "@/lib/registro";
import { ESTUDO_DE_TESTE } from "../../support/estudo-de-teste";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Grava uma Anotação numa conta de teste: precisa do Estudo fixo do banco local compartilhado (e não cria
// conta no Neon). No Neon o arquivo é ignorado; o catálogo cobre a RLS lá.
const emNeon = () => inject("alvoBanco") === "neon";

// Texto privado não pode aparecer em saída alguma quando uma operação privada falha pelos
// caminhos do código. Captura console e os fluxos stdout/stderr do processo.

const rodada = randomUUID();
const idA = randomUUID();
const idB = randomUUID();
const marcador = `MARCADOR-${rodada}`;

let capturado: string[] = [];

async function capturar<T>(fn: () => Promise<T>): Promise<T> {
  const metodos = ["log", "info", "warn", "error", "debug"] as const;
  const espioes = metodos.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      capturado.push(args.map(String).join(" "));
    }),
  );
  const escritaOut = process.stdout.write.bind(process.stdout);
  const escritaErr = process.stderr.write.bind(process.stderr);
  const guardar = (pedaco: unknown) => {
    capturado.push(String(pedaco));
    return true;
  };
  process.stdout.write = guardar as typeof process.stdout.write;
  process.stderr.write = guardar as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = escritaOut;
    process.stderr.write = escritaErr;
    for (const e of espioes) e.mockRestore();
  }
}

// Caminho do código: toda falha privada passa por registrarErro.
async function registrando(contexto: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (erro) {
    registrarErro(contexto, erro);
    return erro;
  }
}

beforeAll(async () => {
  if (emNeon()) return;
  aplicarEnvDeTeste();
  await obterDb()
    .insert(usuario)
    .values([
      { id: idA, email: `a-${rodada}@example.test` },
      { id: idB, email: `b-${rodada}@example.test` },
    ]);
});

afterAll(async () => {
  if (emNeon()) return;
  await obterDb()
    .delete(usuario)
    .where(inArray(usuario.id, [idA, idB]));
  await obterPool().end();
});

describe.skipIf(emNeon())("texto privado fora dos registros", () => {
  it("controle do instrumento: a captura enxerga o que é escrito", async () => {
    capturado = [];
    await capturar(async () => {
      console.error(marcador);
      process.stderr.write(`${marcador}\n`);
    });
    expect(capturado.join("\n")).toContain(marcador);
  });

  it("violação de política, de unicidade e erro genérico não levam o marcador ao registro", async () => {
    const estudo = ESTUDO_DE_TESTE.id;
    await comEstudante(idA, (tx) =>
      tx.insert(anotacao).values({ estudanteId: idA, estudoId: estudo, corpo: "base" }),
    );

    capturado = [];
    const erros: unknown[] = [];
    await capturar(async () => {
      // 1. violação de política: B grava com o id de A
      erros.push(
        await registrando("teste-politica", () =>
          comEstudante(idB, (tx) =>
            tx
              .insert(anotacao)
              .values({ estudanteId: idA, estudoId: ESTUDO_DE_TESTE.id, corpo: marcador }),
          ),
        ),
      );
      // 2. violação de unicidade: A grava de novo no mesmo estudo
      erros.push(
        await registrando("teste-unicidade", () =>
          comEstudante(idA, (tx) =>
            tx.insert(anotacao).values({ estudanteId: idA, estudoId: estudo, corpo: marcador }),
          ),
        ),
      );
      // 3. erro genérico com o texto privado dentro da mensagem
      erros.push(
        await registrando("teste-generico", () =>
          comEstudante(idA, async (tx) => {
            await tx.select().from(anotacao).where(eq(anotacao.estudoId, estudo));
            throw new Error(`falha ao processar: ${marcador}`);
          }),
        ),
      );
    });

    // Os dois erros de banco chegam sanitizados (sem o texto do Drizzle/driver); o vetor segue real
    // para o erro genérico, lançado pelo nosso código com o texto na mensagem, que só o
    // `registrarErro` contém.
    const textos = erros.map((e) => String((e as Error)?.message ?? ""));
    expect(textos.filter((t) => t.includes(marcador))).toHaveLength(1);
    expect(textos[2]).toContain(marcador);

    // Controle positivo: os três registros foram escritos, só com contexto, código e nome.
    const linhas = capturado
      .join("\n")
      .split("\n")
      .filter((l) => l.startsWith("{"));
    expect(linhas).toHaveLength(3);
    const parseadas = linhas.map((l) => JSON.parse(l) as Record<string, string>);
    for (const l of parseadas)
      expect(Object.keys(l).sort()).toEqual(["codigo", "contexto", "nome"]);
    expect(parseadas.map((l) => l.codigo)).toEqual(["42501", "23505", "desconhecido"]);

    // O que importa: o marcador não aparece em nada que foi capturado.
    expect(capturado.join("\n")).not.toContain(marcador);
  });
});
