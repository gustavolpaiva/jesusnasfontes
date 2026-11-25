import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODIGO_DE_CONFLITO } from "../../../scripts/acervo/carregar";
import {
  CODIGO_DE_CONFLITO_COM_O_PAINEL,
  decidirPasso,
  decidirSobreOCodigo,
  linhasDeConflito,
  PASSO_DO_ACERVO,
  PASSOS,
} from "../../../scripts/db/build-producao";
import { gerarBootstrapSql, MARCADORES } from "../../../scripts/db/gerar-bootstrap-sql";
import { decidirAmbiente } from "../../../src/db/decidir-ambiente";

const BAIXADOR_OU_DERIVADOR = /acervo-(baixar|derivar)\.ts/;
const CONFLITO =
  "conflito: fonte-a foi editada no painel (limites_pt); a carga não a tocou e nada foi sobrescrito.";
const OUTRO_CONFLITO =
  "conflito: fonte-b foi editada no painel (secao-1:resumo_pt); a carga não a tocou.";

describe("passo de build de produção", () => {
  it("só roda com VERCEL_ENV exatamente production", () => {
    const producao = decidirPasso("production");
    expect(producao.rodar).toBe(true);
    expect(producao.ensaio).toBe(false);
    expect(producao.passos).toEqual(PASSOS);
    expect(producao.mensagem).toBe("passo de produção: rodando");
    for (const v of [undefined, "", "preview", "development", "Production", "production "]) {
      const d = decidirPasso(v);
      expect(d.rodar).toBe(false);
      expect(d.ensaio).toBe(false);
      expect(d.passos).toEqual([]);
      expect(d.mensagem).toBe(
        `passo de produção: pulado (VERCEL_ENV=${v === undefined || v === "" ? "indefinido" : v})`,
      );
    }
  });

  it("as migrações vêm primeiro e pedem o ambiente producao", () => {
    expect(PASSOS[0]?.script).toBe("scripts/db/migrar.ts");
    expect(PASSOS[0]?.argumentos).toEqual(["--ambiente", "producao"]);
  });

  it("o Acervo vem depois do conteúdo e antes do Admin inicial, pelo carregador, sem argumentos", () => {
    expect(PASSOS.map((p) => p.nome)).toEqual([
      "migrações",
      "Bíblia",
      "conteúdo",
      "Acervo",
      "Admin inicial",
    ]);
    expect(PASSOS[3]).toBe(PASSO_DO_ACERVO);
    expect(PASSO_DO_ACERVO.script).toBe("scripts/acervo/carregar.ts");
    expect(PASSO_DO_ACERVO.argumentos).toEqual([]);
  });

  it("nenhum passo executa o baixador nem o derivador, e o script de build da Vercel não os chama", () => {
    for (const passo of PASSOS) {
      expect(passo.script, passo.nome).not.toMatch(BAIXADOR_OU_DERIVADOR);
      expect(passo.argumentos.join(" "), passo.nome).not.toMatch(BAIXADOR_OU_DERIVADOR);
    }
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["vercel-build"]).toBe("tsx scripts/db/build-producao.ts && next build");
    for (const nome of ["vercel-build", "build"]) {
      expect(pkg.scripts[nome], nome).not.toMatch(BAIXADOR_OU_DERIVADOR);
    }
  });

  it("o código 3 é tolerado SÓ no passo do Acervo; qualquer outro código, em qualquer passo, para o build", () => {
    for (const codigo of [0, 1, 2, 3, 4, -1, null]) {
      for (const passo of PASSOS) {
        const d = decidirSobreOCodigo(passo, codigo, CONFLITO);
        const tolerado = codigo === CODIGO_DE_CONFLITO_COM_O_PAINEL && passo.nome === "Acervo";
        expect(d.seguir, `${passo.nome} com código ${codigo}`).toBe(codigo === 0 || tolerado);
        expect(d.avisos.length > 0, `${passo.nome} com código ${codigo}`).toBe(tolerado);
      }
    }
    // Só o passo do Acervo declara código tolerado.
    expect(PASSOS.filter((p) => (p.codigosTolerados?.length ?? 0) > 0).map((p) => p.nome)).toEqual([
      "Acervo",
    ]);
    expect(PASSO_DO_ACERVO.codigosTolerados).toEqual([CODIGO_DE_CONFLITO_COM_O_PAINEL]);
  });

  it("o aviso do 3 traz uma linha por conflito, do que o carregador imprimiu, e nada além dos conflitos", () => {
    const saida = [
      "puladas (não publicadas e sem derivado): suetonio-doze-cesares",
      `inseridos=0 atualizados=0 inalterados=40 removidos=0`,
      CONFLITO,
      OUTRO_CONFLITO,
      "fontes=37 secoes=300 paragrafos=20000",
      "",
    ].join("\n");
    const d = decidirSobreOCodigo(PASSO_DO_ACERVO, CODIGO_DE_CONFLITO_COM_O_PAINEL, saida);
    expect(d.seguir).toBe(true);
    expect(d.avisos).toEqual([CONFLITO, OUTRO_CONFLITO]);
    expect(linhasDeConflito(saida)).toEqual([CONFLITO, OUTRO_CONFLITO]);
    // Código 0 nunca traz aviso, mesmo com linha parecida na saída.
    expect(decidirSobreOCodigo(PASSO_DO_ACERVO, 0, saida).avisos).toEqual([]);
    // Código 3 sem linha de conflito na saída: o aviso diz isso, em vez de fingir que não houve.
    expect(
      decidirSobreOCodigo(PASSO_DO_ACERVO, CODIGO_DE_CONFLITO_COM_O_PAINEL, "inseridos=0").avisos,
    ).toEqual([expect.stringContaining("sem nenhuma linha de conflito")]);
    // Linha que só parece conflito não vira aviso.
    expect(linhasDeConflito("  conflito: x\nnão é conflito: y\nConflito: z")).toEqual([
      "conflito: x",
    ]);
  });

  it("o código tolerado é o mesmo que o carregador devolve para conflito com o painel, e a linha é a que ele imprime", () => {
    expect(CODIGO_DE_CONFLITO_COM_O_PAINEL).toBe(CODIGO_DE_CONFLITO);
    // Acoplamento declarado: o aviso do build é a linha `conflito: …` do carregador. Se ele mudar a forma da
    // linha, este teste reprova e aponta para os dois lados.
    const carregador = readFileSync("scripts/acervo/carregar.ts", "utf8");
    expect(carregador).toMatch(
      /`conflito: \$\{c\.slug\} foi editada no painel \(\$\{c\.campos\.join\(", "\)\}\); a carga não a tocou/,
    );
  });
});

describe("ensaio em Preview", () => {
  it("sem JNF_ENSAIO_ACERVO a Preview pula, com a mensagem da Fase 1, sem nenhum passo", () => {
    for (const valor of [undefined, ""]) {
      const d = decidirPasso("preview", valor);
      expect(d.rodar).toBe(false);
      expect(d.ensaio).toBe(false);
      expect(d.passos).toEqual([]);
      expect(d.mensagem).toBe("passo de produção: pulado (VERCEL_ENV=preview)");
    }
  });

  it("com JNF_ENSAIO_ACERVO exatamente 1 roda SÓ o passo do Acervo e anuncia o ensaio", () => {
    const d = decidirPasso("preview", "1");
    expect(d.rodar).toBe(true);
    expect(d.ensaio).toBe(true);
    expect(d.passos).toEqual([PASSO_DO_ACERVO]);
    expect(d.mensagem).toBe("passo de ensaio do Acervo: rodando");
  });

  it.each(["true", "01", " 1", "1 ", "2", "0", "sim", "null"])(
    "qualquer outro valor (%j) pula",
    (valor) => {
      const d = decidirPasso("preview", valor);
      expect(d.rodar).toBe(false);
      expect(d.ensaio).toBe(false);
      expect(d.passos).toEqual([]);
      expect(d.mensagem).toBe("passo de produção: pulado (VERCEL_ENV=preview)");
    },
  );

  it("em outro ambiente nunca roda o ensaio, nem com a variável valendo 1", () => {
    for (const v of [undefined, "", "development", "Production", "production "]) {
      const d = decidirPasso(v, "1");
      expect(d.rodar, String(v)).toBe(false);
      expect(d.ensaio, String(v)).toBe(false);
      expect(d.passos, String(v)).toEqual([]);
    }
    // Em produção a variável não muda nada: rodam todos os passos.
    const producao = decidirPasso("production", "1");
    expect(producao.ensaio).toBe(false);
    expect(producao.passos).toEqual(PASSOS);
  });

  it("o par ambiente × banco que não casa é recusado antes de gravar (a regra que o carregador aplica)", () => {
    // O ensaio roda em Preview: banco marcado `producao` é recusado. O passo de produção: banco `dev` é recusado.
    expect(() => decidirAmbiente("producao", "preview")).toThrow(/Ambiente recusado/);
    expect(() => decidirAmbiente("dev", "production")).toThrow(/Ambiente recusado/);
    expect(() => decidirAmbiente("dev", "preview")).not.toThrow();
    expect(() => decidirAmbiente("dev", undefined)).not.toThrow();
    expect(() => decidirAmbiente("producao", "production")).not.toThrow();
  });
});

describe("SQL dos papéis para o editor do Neon", () => {
  const sql = gerarBootstrapSql();

  it("traz os quatro marcadores de senha, um por linha, e nenhuma senha", () => {
    for (const m of Object.values(MARCADORES)) {
      expect(sql.split("\n").filter((l) => l.includes(`'${m}'`))).toHaveLength(1);
    }
    expect(sql).not.toMatch(/password\s+'(?!<SENHA_JNF_)/);
  });

  it("não cria superusuário nem usa bypassrls e cobre esquemas e privilégios padrão", () => {
    expect(sql).not.toMatch(/\bcreate role[^;]*\b(superuser|bypassrls)\b/i);
    for (const esquema of ["acervo", "conteudo", "privado", "admin", "auth"]) {
      expect(sql).toContain(`create schema if not exists ${esquema} authorization jnf_migra;`);
    }
    expect(sql).toContain(
      "alter default privileges for role jnf_migra in schema acervo grant select on tables to jnf_assistente;",
    );
  });
});
