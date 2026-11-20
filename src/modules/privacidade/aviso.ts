import { createHash } from "node:crypto";
import { envAviso } from "@/lib/env";

// O aviso de privacidade (PRIV-01, PRIV-02). Texto versionado: mudar QUALQUER palavra dele exige subir
// `VERSAO_AVISO` e acrescentar a mudança em `MUDANCAS_DO_AVISO`, porque é a versão que decide quem
// precisa consentir de novo. O responsável e o contato vêm do ambiente (AVISO_RESPONSAVEL e
// AVISO_CONTATO, do cofre), nunca de arquivo versionado. Sem `server-only`: os testes o importam.
//
// O que o texto afirma só vale se foi MEDIDO (ver o SUMMARY do plano 01-14, "O que o dono confirma"):
// - o banco fica em São Paulo (host sa-east-1 do projeto de desenvolvimento do Neon);
// - o prazo das cópias é o do plano gratuito do Neon (documentação lida em 19/11/2026);
// - a conta de envio de e-mail foi criada na região de São Paulo, mas o alvo técnico de retorno do
//   envio publica endereços nos Estados Unidos: por isso o texto NÃO afirma que o e-mail é tratado só no
//   Brasil, nem que não é.

export const VERSAO_AVISO = "1";
/** Data da versão, em ISO (AAAA-MM-DD). */
export const DATA_AVISO = "2026-11-19";
/** Janela de histórico do banco no plano gratuito do Neon (neon.com/docs/introduction/plans). */
export const PRAZO_DAS_COPIAS = "6 horas";
export const REGIAO_DO_BANCO = "São Paulo";

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-11-19" vira "19 de novembro de 2026". */
export function dataPorExtenso(iso: string): string {
  const [ano, mes, dia] = iso.split("-").map(Number);
  const nome = MESES[(mes ?? 0) - 1];
  if (!ano || !dia || !nome) throw new Error("Data do aviso inválida.");
  return `${dia} de ${nome} de ${ano}`;
}

export type SecaoDoAviso = { id: string; titulo: string; paragrafos: string[] };

type Valores = { responsavel: string; contato: string };

function valoresDoAmbiente(): Valores {
  const env = envAviso();
  return { responsavel: env.AVISO_RESPONSAVEL, contato: env.AVISO_CONTATO };
}

/** Os sete blocos do aviso, na ordem em que aparecem. */
export function secoesDoAviso(valores: Valores = valoresDoAmbiente()): SecaoDoAviso[] {
  return [
    {
      id: "responsavel",
      titulo: "Quem cuida dos seus dados",
      paragrafos: [`O responsável é ${valores.responsavel}. Contato: ${valores.contato}.`],
    },
    {
      id: "guardamos",
      titulo: "O que guardamos",
      paragrafos: [
        "Seu e-mail, suas Anotações, suas Sessões, o que você marcou como concluído, o ponto em que parou em cada Trilha e o registro deste aceite.",
        "Para limitar tentativas de acesso, guardamos também um resumo codificado do seu e-mail e do endereço de rede do aparelho, e não os valores em si.",
      ],
    },
    {
      id: "crenca",
      titulo: "Isto pode revelar sua crença",
      paragrafos: [
        "O que você escreve aqui sobre Jesus e a fé pode revelar sua crença religiosa. A lei brasileira trata isso como dado sensível e, por isso, pedimos o seu consentimento de forma separada e clara.",
      ],
    },
    {
      id: "quem-le",
      titulo: "Quem lê suas Anotações",
      paragrafos: [
        "O site impede que outros Estudantes e os Admins leiam suas Anotações. Mas as Anotações não são cifradas: quem administra o banco de dados e as contas da hospedagem teria acesso técnico a elas. Se isso não serve para você, não escreva aqui o que não quer que essa pessoa possa ver.",
      ],
    },
    {
      id: "onde",
      titulo: "Onde ficam os dados",
      paragrafos: [
        `Em serviços de terceiros. A Vercel hospeda o site; configuramos as funções dela para rodar em São Paulo, mas ela pode tratar pedidos e registros de acesso fora do Brasil. A Neon guarda o banco de dados, em ${REGIAO_DO_BANCO}.`,
        "A Resend envia os e-mails. Escolhemos a região de São Paulo para o envio, mas parte da rota técnica de retorno dessa conta usa servidores nos Estados Unidos; por isso não garantimos que seu e-mail seja tratado só no Brasil. A Cloudflare só resolve o endereço do site.",
      ],
    },
    {
      id: "aparelho",
      titulo: "Neste aparelho",
      paragrafos: [
        "O rascunho de uma Anotação fica guardado neste aparelho até ser enviado, e é apagado quando você sai.",
      ],
    },
    {
      id: "direitos",
      titulo: "Seus direitos",
      paragrafos: [
        `Você pode baixar todos os seus dados e apagar a conta quando quiser, em Conta. Dados apagados saem do site na hora, mas podem continuar nas cópias de segurança do banco por até ${PRAZO_DAS_COPIAS}.`,
        "Os e-mails de acesso que já enviamos podem continuar no registro do serviço de envio pelo prazo que ele define.",
      ],
    },
  ];
}

/** O texto corrido do aviso, exatamente como é mostrado (base do `texto_hash`). */
export function textoDoAviso(secoes: SecaoDoAviso[] = secoesDoAviso()): string {
  return secoes.map((s) => [s.titulo, ...s.paragrafos].join("\n")).join("\n\n");
}

/** sha256 do texto renderizado, gravado junto do aceite: prova do que a pessoa leu. */
export function hashDoAviso(secoes: SecaoDoAviso[] = secoesDoAviso()): string {
  return createHash("sha256").update(textoDoAviso(secoes), "utf8").digest("hex");
}

/** "Aviso versão 1, de 19 de novembro de 2026." */
export function linhaDaVersao(versao: string = VERSAO_AVISO, data: string = DATA_AVISO): string {
  return `Aviso versão ${versao}, de ${dataPorExtenso(data)}.`;
}

/** O que mudou em cada versão, para a lista "O que mudou" de quem consentiu uma versão anterior. */
export const MUDANCAS_DO_AVISO: Readonly<Record<string, readonly string[]>> = {
  "1": [],
};

export function mudancasDoAviso(
  versao: string = VERSAO_AVISO,
  tabela: Readonly<Record<string, readonly string[]>> = MUDANCAS_DO_AVISO,
): readonly string[] {
  return tabela[versao] ?? [];
}
