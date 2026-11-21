import { describe, expect, it } from "vitest";
import { decidirPasso, PASSOS } from "../../../scripts/db/build-producao";
import { gerarBootstrapSql, MARCADORES } from "../../../scripts/db/gerar-bootstrap-sql";

describe("passo de build de produção", () => {
  it("só roda com VERCEL_ENV exatamente production", () => {
    expect(decidirPasso("production").rodar).toBe(true);
    for (const v of [undefined, "", "preview", "development", "Production", "production "]) {
      const d = decidirPasso(v);
      expect(d.rodar).toBe(false);
      expect(d.mensagem).toContain("passo de produção: pulado (VERCEL_ENV=");
    }
  });

  it("as migrações vêm primeiro e pedem o ambiente producao", () => {
    expect(PASSOS[0]?.script).toBe("scripts/db/migrar.ts");
    expect(PASSOS[0]?.argumentos).toEqual(["--ambiente", "producao"]);
    expect(PASSOS.map((p) => p.nome)).toEqual(["migrações", "Bíblia", "conteúdo", "Admin inicial"]);
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
