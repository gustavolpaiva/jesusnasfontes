import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { exportarDados } from "@/modules/privacidade/exportar";
import { travarProgresso } from "@/modules/trilhas/consultas";
import { removerBancoDeExecucao } from "../../support/banco-local";
import {
  comoDono,
  criarTerreno,
  type Terreno,
  tabelasDoCatalogo,
} from "../../support/conta-completa";

// Exportar (PRIV-03): todos os dados da conta A e nenhum de B. As tabelas vêm do catálogo. Cria contas
// e linhas num banco descartável só deste arquivo, então não roda no Neon.

const emNeon = () => inject("alvoBanco") === "neon";

let t: Terreno;

beforeAll(async () => {
  if (emNeon()) return;
  t = await criarTerreno();
  // O pool do aplicativo nasce depois disto e aponta para o banco deste arquivo.
  Object.assign(process.env, t.env);
});

afterAll(async () => {
  if (emNeon()) return;
  await obterPool().end();
  await removerBancoDeExecucao(t.banco.nome);
});

describe.skipIf(emNeon())("exportarDados", () => {
  it("A exporta as próprias linhas de TODA tabela privada do catálogo, e a lista de tabelas é a do catálogo", async () => {
    const dados = await exportarDados(t.a.id);
    const privadas = await tabelasDoCatalogo(t.env, "privado");
    // Controle positivo: o catálogo traz mais de uma tabela.
    expect(privadas.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(dados.tabelas).sort()).toEqual(privadas);
    for (const nome of privadas) {
      expect(dados.tabelas[nome]?.length, `${nome}: linhas de A`).toBeGreaterThan(0);
    }
    expect(dados.tabelas.anotacao?.[0]?.corpo).toBe(`corpo ${t.a.marcador}`);
    expect(dados.tabelas.conclusao).toHaveLength(2);
    expect(dados.tabelas.volta_leitura?.[0]?.volta_atual).toBe(2);
    expect(dados.tabelas.consentimento?.[0]?.versao_aviso).toBe("1");
    expect(dados.versaoFormato).toBe(1);
    expect(Number.isNaN(Date.parse(dados.geradoEm))).toBe(false);
    expect(dados.perfil.email).toBe(t.a.email);
    expect(dados.convite?.estado).toBe("aceito");
    // A coluna gerada da busca não vai ao arquivo.
    expect(dados.tabelas.anotacao?.[0]).not.toHaveProperty("tsv");
  });

  it("exportar espera quem está na fila de escrita da conta (apagar ou progresso) e sai inteiro", async () => {
    let soltar = () => {};
    const portao = new Promise<void>((r) => {
      soltar = r;
    });
    let travou = () => {};
    const jaTravou = new Promise<void>((r) => {
      travou = r;
    });
    const dono = comEstudante(t.a.id, async (tx) => {
      await travarProgresso(tx, t.a.id);
      travou();
      await portao;
    });
    await jaTravou;
    let terminou = false;
    const exportacao = exportarDados(t.a.id).then((d) => {
      terminou = true;
      return d;
    });
    // A conta vizinha não espera: a fila é por conta (controle positivo de que o banco responde).
    expect((await exportarDados(t.b.id)).perfil.email).toBe(t.b.email);
    await new Promise((r) => setTimeout(r, 400));
    expect(terminou).toBe(false);
    soltar();
    await dono;
    const dados = await exportacao;
    expect(dados.perfil.email).toBe(t.a.email);
    expect(dados.tabelas.conclusao).toHaveLength(2);
  });

  it("nada de B aparece no arquivo de A (e vice-versa), nem de sessões, segredos ou tokens", async () => {
    const deA = JSON.stringify(await exportarDados(t.a.id));
    const deB = JSON.stringify(await exportarDados(t.b.id));
    // Controle positivo: cada arquivo traz o marcador do próprio dono.
    expect(deA).toContain(t.a.marcador);
    expect(deB).toContain(t.b.marcador);
    // Negativo, nos dois sentidos.
    expect(deA).not.toContain(t.b.marcador);
    expect(deA).not.toContain(t.b.email);
    expect(deB).not.toContain(t.a.marcador);
    expect(deB).not.toContain(t.a.email);
    // O arquivo não leva o que é só da plataforma: token de sessão, segredo e códigos do segundo fator.
    for (const segredo of [
      `token-${t.a.marcador}`,
      `segredo-${t.a.marcador}`,
      `codigos-${t.a.marcador}`,
    ]) {
      expect(deA, segredo).not.toContain(segredo);
    }
  });

  it("uma tabela privada criada depois entra no arquivo sozinha, sem mudar o código", async () => {
    await comoDono(t.env, async (c) => {
      await c.query(`create table privado.zz_futura (
        estudante_id uuid not null references auth."user" (id) on delete cascade,
        nota text not null)`);
      await c.query("alter table privado.zz_futura enable row level security");
      await c.query("alter table privado.zz_futura force row level security");
      await c.query(`create policy dono on privado.zz_futura for all
        using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
        with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)`);
      await c.query("grant select, insert, update, delete on privado.zz_futura to jnf_app");
      await c.query("insert into privado.zz_futura values ($1, 'de A'), ($2, 'de B')", [
        t.a.id,
        t.b.id,
      ]);
    });
    try {
      const dados = await exportarDados(t.a.id);
      expect(dados.tabelas.zz_futura).toEqual([{ estudante_id: t.a.id, nota: "de A" }]);
    } finally {
      await comoDono(t.env, (c) => c.query("drop table privado.zz_futura"));
    }
  });

  it("uma tabela de privado SEM estudante_id faz a exportação falhar em vez de ser omitida", async () => {
    await comoDono(t.env, (c) => c.query("create table privado.zz_sem_dono (x int)"));
    try {
      await expect(exportarDados(t.a.id)).rejects.toThrow(/sem estudante_id: zz_sem_dono/);
    } finally {
      await comoDono(t.env, (c) => c.query("drop table privado.zz_sem_dono"));
    }
  });

  it("conta inexistente não exporta nada", async () => {
    await expect(exportarDados("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
      "Conta inexistente.",
    );
  });
});
