import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Lê o transporte em arquivo (MAIL_DIR da execução). Só endereços sob domínios reservados.

export type EmailLido = {
  para: string;
  assunto: string;
  texto: string;
  html: string;
  link: string | null;
  codigo: string | null;
};

function lerTodos(): EmailLido[] {
  const pasta = process.env.MAIL_DIR;
  if (!pasta) throw new Error("MAIL_DIR ausente: o e2e deve rodar por scripts/dev/e2e.ts");
  let nomes: string[] = [];
  try {
    nomes = readdirSync(pasta)
      .filter((nome) => nome.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return nomes.map((nome) => {
    const mensagem = JSON.parse(readFileSync(join(pasta, nome), "utf8")) as Omit<
      EmailLido,
      "link" | "codigo"
    >;
    const link = /https?:\/\/\S+\/entrar\/confirmar\?token=\S+/.exec(mensagem.texto)?.[0] ?? null;
    const codigo =
      /código de 6 dígitos na tela de entrada: (\d{6})/.exec(mensagem.texto)?.[1] ?? null;
    return { ...mensagem, link, codigo };
  });
}

export function emailsPara(endereco: string): EmailLido[] {
  return lerTodos().filter((m) => m.para === endereco.toLowerCase());
}

export function totalDeEmails(): number {
  return lerTodos().length;
}

// Espera (o envio acontece depois da resposta) pelo e-mail de acesso mais recente.
export async function ultimoEmailPara(
  endereco: string,
  opcoes: { depoisDe?: number; assunto?: RegExp } = {},
): Promise<EmailLido> {
  const assunto = opcoes.assunto ?? /acesso/i;
  const minimo = opcoes.depoisDe ?? 0;
  for (let i = 0; i < 100; i++) {
    const achados = emailsPara(endereco).filter((m) => assunto.test(m.assunto));
    if (achados.length > minimo) return achados[achados.length - 1] as EmailLido;
    await new Promise((resolver) => setTimeout(resolver, 100));
  }
  throw new Error("Nenhum e-mail chegou para o endereço do teste");
}
