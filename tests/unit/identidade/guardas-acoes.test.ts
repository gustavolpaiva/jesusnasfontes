import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Toda Server Action chamável pelo navegador passa pela mesma guarda (`exigirSessao`,
// `exigirAdmin` ou `exigirPrimeiroFatorDeAdmin`), direto ou por uma função local que ela chama.
// Só as ações de ENTRADA (quem ainda não tem sessão) e `sair` ficam de fora, por nome, e a lista é
// fechada: uma ação nova sem guarda faz este teste falhar.

const GUARDAS = /\b(exigirSessao|exigirAdmin|exigirPrimeiroFatorDeAdmin)\s*\(/;
const PUBLICAS = new Map([
  // Preferência de aparência: só grava um cookie do próprio navegador, sem dado de conta.
  ["modules/aparencia/acoes.ts", new Set(["definirTema", "definirPasso"])],
  [
    "modules/identidade/entrada.ts",
    new Set(["pedirEntrada", "reenviarAcesso", "entrarComCodigo", "confirmarEntrada", "sair"]),
  ],
]);

function acoesSemGuarda(fonte: string, publicas: Set<string> = new Set()): string[] {
  const arquivo = ts.createSourceFile("x.ts", fonte, ts.ScriptTarget.Latest, true);
  const corpos = new Map<string, string>();
  const exportadas: string[] = [];
  arquivo.forEachChild((no) => {
    if (ts.isFunctionDeclaration(no) && no.name && no.body) {
      corpos.set(no.name.text, no.body.getText());
      if (no.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exportadas.push(no.name.text);
      }
    }
  });
  return exportadas.filter((nome) => {
    if (publicas.has(nome)) return false;
    const corpo = corpos.get(nome) ?? "";
    if (GUARDAS.test(corpo)) return false;
    // Uma volta: função local chamada pelo corpo que contém a guarda.
    return !Array.from(corpos).some(
      ([outra, c]) =>
        outra !== nome && new RegExp(`\\b${outra}\\s*\\(`).test(corpo) && GUARDAS.test(c),
    );
  });
}

function arquivosUseServer(): string[] {
  const raiz = join(process.cwd(), "src");
  const achados: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (/\.tsx?$/.test(nome) && /^\s*["']use server["']/.test(readFileSync(caminho, "utf8")))
        achados.push(caminho.slice(raiz.length + 1));
    }
  };
  andar(raiz);
  return achados;
}

describe("guarda das Server Actions", () => {
  it("controle do instrumento: a varredura acusa ação sem guarda e aceita a guardada", () => {
    const sem = `"use server";\nexport async function apagar() { return 1; }`;
    const com = `"use server";\nexport async function apagar() { await exigirSessao(); return 1; }`;
    const indireta = `"use server";\nexport async function a() { return b(); }\nasync function b() { await exigirAdmin(); }`;
    expect(acoesSemGuarda(sem)).toEqual(["apagar"]);
    expect(acoesSemGuarda(com)).toEqual([]);
    expect(acoesSemGuarda(indireta)).toEqual([]);
    expect(acoesSemGuarda(sem, new Set(["apagar"]))).toEqual([]);
  });

  it("toda ação exportada de todo arquivo 'use server' tem guarda ou está na lista fechada de entrada", () => {
    const arquivos = arquivosUseServer();
    expect(arquivos).toEqual(
      expect.arrayContaining([
        "modules/identidade/entrada.ts",
        "modules/identidade/segundo-fator.ts",
      ]),
    );
    for (const a of arquivos) {
      const sem = acoesSemGuarda(
        readFileSync(join(process.cwd(), "src", a), "utf8"),
        PUBLICAS.get(a) ?? new Set(),
      );
      expect(sem, `${a}: ação sem guarda`).toEqual([]);
    }
  });
});
