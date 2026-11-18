import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Tabela "Sobre as restilizações" do contrato visual: cada linha da coluna "Padrão do shadcn"
// vira um padrão proibido nos componentes copiados.
const DIRETORIO = "src/components/ui";
const arquivos = readdirSync(DIRETORIO).filter((nome) => nome.endsWith(".tsx"));
const fonte = (nome: string) => readFileSync(`${DIRETORIO}/${nome}`, "utf8");

// Uma classe do Tailwind começa depois de aspas, espaço, crase ou dois-pontos (variante).
const classe = (padrao: string) => new RegExp(`(?:^|[\\s"'\`:\\[])(?:${padrao})(?=$|[\\s"'\`\\]])`);

const proibidos: Array<[string, RegExp]> = [
  [
    "cantos arredondados (rounded-md/lg/xl/2xl/3xl/full ou valor livre)",
    classe("rounded-(?:md|lg|xl|2xl|3xl|full|\\[[^\\]]+\\])"),
  ],
  ["sombra (shadow-*)", classe("(?:[\\w-]+:)*shadow(?:-[\\w[\\]./-]+)?")],
  ["anel de foco (ring-*)", classe("(?:[\\w-]+:)*ring-[\\w[\\]./-]+")],
  ["deslocamento de anel (ring-offset)", classe("(?:[\\w-]+:)*ring-offset-[\\w[\\]./-]+")],
  [
    "altura de controle do shadcn (h-6 a h-10, size-6 a size-10 em controle)",
    classe("h-(?:6|7|8|9|10)"),
  ],
  [
    "tamanhos de texto do Tailwind (text-xs/sm/base/lg/xl/2xl…)",
    classe("(?:[\\w-]+:)*text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|\\[[^\\]]+\\])"),
  ],
  [
    "peso fora de 400 e 600 (font-medium, font-bold, font-light…)",
    classe("(?:[\\w-]+:)*font-(?:thin|extralight|light|medium|bold|extrabold|black)"),
  ],
  ["transition-all", classe("transition-all")],
  ["hover em bg-accent", classe("(?:[\\w-]+:)*bg-accent(?:/[\\d]+)?")],
  ["placeholder em muted-foreground", classe("placeholder:text-muted-foreground")],
  ["variante de tema escuro escrita no componente (dark:)", /(?:^|[\s"'`])dark:/],
];

describe("componentes do shadcn restilizados (tabela do contrato)", () => {
  it("controle positivo: os arquivos foram lidos e são pelo menos 16", () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(16);
    expect(fonte("button.tsx")).toContain("min-h-12");
  });

  it("os componentes proibidos não existem", () => {
    for (const nome of ["card", "sonner", "tooltip", "hover-card", "select", "popover", "tabs"]) {
      expect(arquivos, nome).not.toContain(`${nome}.tsx`);
    }
  });

  for (const [descricao, padrao] of proibidos) {
    it(`nenhum arquivo usa ${descricao}`, () => {
      const achados = arquivos.flatMap((nome) => {
        const texto = fonte(nome)
          .split("\n")
          // Comentários de linha e de bloco não são classes.
          .filter((linha) => !/^\s*(?:\/\/|\/?\*)/.test(linha))
          .join("\n");
        // Exceção declarada: o disco do radio pode ser redondo.
        const alvo = nome === "radio-group.tsx" ? texto.replace(/rounded-full/g, "") : texto;
        return padrao.test(alvo) ? [nome] : [];
      });
      expect(achados).toEqual([]);
    });
  }

  it("folhas e diálogos têm o limite border-input", () => {
    for (const nome of ["sheet.tsx", "alert-dialog.tsx"]) {
      expect(fonte(nome), nome).toContain("border-input");
    }
  });

  it("o foco é o contorno de 2 px nos controles", () => {
    for (const nome of [
      "button.tsx",
      "input.tsx",
      "textarea.tsx",
      "checkbox.tsx",
      "radio-group.tsx",
    ]) {
      expect(fonte(nome), nome).toContain("focus-visible:outline-2");
      expect(fonte(nome), nome).toContain("focus-visible:outline-offset-2");
    }
  });

  it("nada importa o pacote `cn` (só o utilitário do projeto)", () => {
    for (const nome of arquivos) {
      expect(fonte(nome), nome).not.toMatch(/from "cn"/);
    }
  });

  it("o botão pendente marca aria-busy e não usa ícone giratório", () => {
    const botao = fonte("button.tsx");
    expect(botao).toContain("aria-busy");
    expect(botao).not.toMatch(/animate-spin|Loader/);
  });

  it("a checkbox tem caixa de 24 px dentro de área de 44 px", () => {
    const caixa = fonte("checkbox.tsx");
    expect(caixa).toContain("size-11");
    expect(caixa).toContain("size-6");
  });
});
