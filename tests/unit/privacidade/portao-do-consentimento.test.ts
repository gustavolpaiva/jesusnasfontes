import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// O portão do consentimento (PRIV-01) tem uma lista FECHADA de furos, por arquivo e por quantidade de
// chamadas: as telas do próprio aviso e, por decisão do dono (20/11/2026), exportar e apagar a conta para
// quem não aceitou a versão atual. Qualquer outro arquivo que passe `exigirConsentimento: false` (uma
// ação de progresso, uma página nova) reprova aqui até alguém decidir, por escrito, abrir mais um furo.

const FUROS = new Map<string, number>([
  ["app/(consentimento)/layout.tsx", 1],
  ["app/(consentimento)/privacidade/aceitar/page.tsx", 1],
  ["app/(consentimento)/privacidade/seus-dados/page.tsx", 1],
  ["app/(estudante)/conta/exportar/route.ts", 1],
  ["modules/privacidade/acoes-consentimento.ts", 2],
  ["modules/privacidade/apagar.ts", 2],
]);

const CHAMADA_SEM_PORTAO = /exigirSessao\(\s*\{[^}]*exigirConsentimento:\s*false/g;

function furosEm(fonte: string): number {
  return fonte.match(CHAMADA_SEM_PORTAO)?.length ?? 0;
}

function furosDoApp(): Map<string, number> {
  const raiz = join(process.cwd(), "src");
  const achados = new Map<string, number>();
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (/\.tsx?$/.test(nome)) {
        const n = furosEm(readFileSync(caminho, "utf8"));
        if (n > 0) achados.set(caminho.slice(raiz.length + 1), n);
      }
    }
  };
  andar(raiz);
  return achados;
}

describe("furos do portão do consentimento", () => {
  it("controle do instrumento: a varredura conta a chamada sem portão e ignora a guardada", () => {
    expect(furosEm("await exigirSessao({ exigirConsentimento: false });")).toBe(1);
    expect(furosEm("await exigirSessao();")).toBe(0);
    expect(furosEm("// opções: `exigirConsentimento: false`")).toBe(0);
  });

  it("só os arquivos da lista fechada chamam exigirSessao sem o consentimento", () => {
    expect(Object.fromEntries(furosDoApp())).toEqual(Object.fromEntries(FUROS));
  });

  it("as ações de progresso e as páginas do Estudante nunca passam sem o portão", () => {
    const achados = furosDoApp();
    for (const arquivo of achados.keys()) {
      expect(arquivo, arquivo).not.toMatch(/modules\/trilhas\//);
      expect(arquivo, arquivo).not.toMatch(/\(leitura\)/);
    }
  });
});
