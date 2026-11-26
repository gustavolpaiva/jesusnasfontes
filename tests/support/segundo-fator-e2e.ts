import { expect, type Page } from "@playwright/test";
import { gerarTotp } from "./totp";

// Confirma o segundo fator na tela dele. O código da ativação (o passo atual) já foi usado e não vale de novo; o do
// passo seguinte vale, MAS só enquanto o relógio não andou um passo inteiro desde a ativação (com o servidor de teste
// ocupado isso acontece). Então tenta o passo atual e, se o pedido for RECUSADO, o seguinte: o que decide é o RESULTADO
// do pedido, nunca um tempo.
//
// Como se lê o resultado: no acerto a ação redireciona e a página SAI da verificação; na recusa o campo de código é
// esvaziado e recebe o foco (só a recusa o esvazia). Enquanto nenhum dos dois aconteceu, o pedido ainda está no ar.
// A leitura do campo tem teto curto SÓ para não ficar presa a uma navegação em curso: quando ela estoura, o desfecho é
// "ainda no ar" (nunca "recusado"), e a rodada seguinte vê a página nova. O prazo da espera é o do teste, como em todo
// `waitFor` do repositório.
export async function confirmarSegundoFator(page: Page, chave: string): Promise<void> {
  const saiu = () => !new URL(page.url()).pathname.endsWith("/admin/segundo-fator");
  const campo = page.getByLabel("Código de 6 dígitos");
  for (const adiante of [0, 30_000, 60_000]) {
    await campo.fill(gerarTotp(chave, Date.now() + adiante));
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect
      .poll(
        async () => {
          if (saiu()) return "aceito";
          const digitado = await campo.inputValue({ timeout: 1_000 }).catch(() => null);
          if (saiu()) return "aceito";
          if (digitado === null) return "no ar";
          return digitado === "" ? "recusado" : "no ar";
        },
        { timeout: 0, intervals: [100, 250, 500] },
      )
      .not.toBe("no ar");
    if (saiu()) return;
  }
  throw new Error("confirmarSegundoFator: os três passos do relógio foram recusados.");
}
