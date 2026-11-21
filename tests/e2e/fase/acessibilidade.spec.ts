import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prepararTela, TELAS } from "./telas";

// UI-01 e UI-02 (plano 01-19): toda tela e estado da fase passa no axe sem violações, nas larguras 320,
// 360, 390 e 1280, claro e escuro (os projetos `varredura-*` do Playwright dão a largura e o esquema).
// Conteúdo real e banco da execução. Controle positivo: o axe rodou regras de verdade (passes > 0).

for (const tela of TELAS) {
  test(`@varredura axe sem violações: ${tela.id}`, async ({ page }) => {
    test.setTimeout(90_000);
    await prepararTela(page, tela);
    const resultado = await new AxeBuilder({ page }).analyze();
    expect(resultado.passes.length).toBeGreaterThan(10);
    // Cada violação traz o id, a contagem e os primeiros alvos: o relatório já diz onde olhar.
    expect(
      resultado.violations.map(
        (v) =>
          `${v.id}: ${v.nodes.length} (${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(" "))
            .join(" | ")})`,
      ),
    ).toEqual([]);
  });
}
