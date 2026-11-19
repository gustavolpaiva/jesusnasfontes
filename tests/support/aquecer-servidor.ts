import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { emailDeTeste, entrarPorLink, semearAdminParaTeste } from "./login-e2e";
import { gerarTotp } from "./totp";

// Aquecimento do servidor de desenvolvimento, uma vez, antes de qualquer teste.
//
// O `next dev` compila cada rota na primeira requisição. Sem isto, os primeiros testes de cada
// arquivo pagavam essa compilação (de 3 a 10 s sob carga) e, com cinco processos de teste pedindo
// as mesmas rotas ao mesmo tempo, a pagavam em dobro: o tempo de um teste dependia de quem chegava
// primeiro e de a máquina estar ociosa. Aqui as rotas são lidas do disco (a mesma regra do teste da
// lista de rotas), cada uma recebe um GET sem sessão e o servidor as compila de uma vez.
//
// O GET não entra em conta nem em limite algum: sem sessão, as páginas protegidas redirecionam
// depois de compiladas, e `/entrar/confirmar` sem token só mostra a tela. Nada é enviado nem gravado.
//
// Só o GET não basta: a primeira entrada de verdade (pedir acesso, confirmar o link, cadastrar o
// segundo fator, abrir as páginas já autenticado) compila e inicializa mais coisa, e custava 3 s a
// quem a fizesse primeiro contra 1,2 s das seguintes (medido). Por isso o aquecimento faz UMA entrada
// completa de um Admin descartável, pelas mesmas funções dos testes, do banco da execução.

function rotasDoApp(): string[] {
  const raiz = join(process.cwd(), "src", "app");
  const achadas: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (/^(page|route)\.tsx?$/.test(nome)) {
        const segmentos = relative(raiz, dir)
          .split("/")
          .filter((x) => x !== "" && !/^\(.*\)$/.test(x))
          // Segmento dinâmico: um valor qualquer; o `[...all]` da biblioteca de entrada recebe uma
          // rota que ela de fato serve (e que a lista de permissão deixa passar).
          .map((x) => (x === "[...all]" ? "get-session" : /^\[.*\]$/.test(x) ? "aquecer" : x));
        achadas.push(`/${segmentos.join("/")}`);
      }
    }
  };
  andar(raiz);
  return achadas;
}

const SIMULTANEAS = 4;

async function entradaCompleta(base: string): Promise<void> {
  const navegador = await chromium.launch();
  try {
    const contexto = await navegador.newContext({ baseURL: base });
    const pagina = await contexto.newPage();
    const endereco = emailDeTeste("aquecer");
    await semearAdminParaTeste(endereco);
    await entrarPorLink(pagina, endereco, "Ative o segundo fator");
    const chave = ((await pagina.getByTestId("chave").textContent()) ?? "").replace(/\s/g, "");
    await pagina.getByLabel("Código de 6 dígitos").fill(gerarTotp(chave));
    await pagina.getByRole("button", { name: "Ativar" }).click();
    await pagina
      .getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" })
      .waitFor();
    await pagina.getByLabel("Guardei os códigos em um lugar seguro.").click();
    await pagina.getByRole("button", { name: "Concluir" }).click();
    await pagina.getByRole("heading", { level: 1, name: "Administração" }).waitFor();
    for (const rota of ["/trilhas", "/estudos/aquecer"]) await pagina.goto(rota);
  } finally {
    await navegador.close();
  }
}

export default async function aquecer(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) throw new Error("aquecer-servidor: o projeto não tem baseURL");
  const rotas = rotasDoApp();
  const inicio = Date.now();
  const fila = [...rotas];
  const trabalhador = async () => {
    for (let rota = fila.shift(); rota !== undefined; rota = fila.shift()) {
      // Resposta ignorada: só interessa que o servidor compilou a rota.
      await fetch(new URL(rota, base), { redirect: "manual" }).then((r) => r.arrayBuffer());
    }
  };
  await Promise.all(Array.from({ length: SIMULTANEAS }, trabalhador));
  await entradaCompleta(base);
  console.log(`servidor aquecido: ${rotas.length} rotas em ${Date.now() - inicio} ms`);
}
