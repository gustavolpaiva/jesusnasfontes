import type { Locator } from "@playwright/test";

// Um clique ou uma digitação antes da hidratação não faz nada (o campo ainda não tem o tratador do React, e o
// valor digitado é perdido quando o React assume): espera o React ligar o elemento, em vez de contar com a
// sorte do tempo.
export async function esperarHidratado(elemento: Locator): Promise<void> {
  await elemento.waitFor();
  await elemento.evaluate(
    (el) =>
      new Promise<void>((pronto) => {
        const ligado = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        const olhar = () => (ligado() ? pronto() : setTimeout(olhar, 25));
        olhar();
      }),
  );
}
