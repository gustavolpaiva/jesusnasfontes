import { expect, test } from "@playwright/test";
import { algarismosEmVersalete } from "../../support/algarismos-em-versalete";
import { prepararTela, TELAS } from "./telas";

// Rótulo em versalete verdadeiro (`text-label`, `font-variant-caps: small-caps`) deixa o algarismo
// ilegível: na EB Garamond os algarismos de versalete se parecem com letras ("p. 101" sai "p. ioi"), e
// um número de página, de seção ou de data que se lê como letra é erro de conteúdo (plano 02-ajustes,
// defeito 3). A regra é de CLASSE, não de caso: em toda tela da fase, todo texto visível que traz
// algarismo está fora do versalete (o `.algarismos` o desliga e põe algarismos de altura de maiúscula).
// Roda no Chromium de computador: o computed style não depende do motor, e a varredura de larguras
// não muda o que se mede aqui.

for (const tela of TELAS) {
  test(`algarismos em Rótulo ficam fora do versalete: ${tela.id}`, async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(test.info().project.name !== "computador", "o estilo calculado não depende do motor");
    await prepararTela(page, tela);
    const achados = await algarismosEmVersalete(page);
    expect(achados).toEqual([]);
  });
}

test("controle positivo: o Rótulo é versalete e o `.algarismos` o desliga", async ({ page }) => {
  test.skip(test.info().project.name !== "computador", "o estilo calculado não depende do motor");
  await page.goto("/entrar");
  const medido = await page.evaluate(() => {
    const rotulo = document.createElement("p");
    rotulo.className = "text-label";
    rotulo.innerHTML = 'p. <span class="algarismos">101</span>';
    document.body.append(rotulo);
    const numero = rotulo.querySelector(".algarismos") as HTMLElement;
    const cr = getComputedStyle(rotulo);
    const cn = getComputedStyle(numero);
    const resultado = {
      rotuloCaps: cr.fontVariantCaps,
      numeroCaps: cn.fontVariantCaps,
      numeroNums: cn.fontVariantNumeric,
    };
    rotulo.remove();
    return resultado;
  });
  expect(medido.rotuloCaps).toBe("small-caps");
  expect(medido.numeroCaps).toBe("normal");
  expect(medido.numeroNums).toContain("lining-nums");
  expect(medido.numeroNums).toContain("tabular-nums");
});
