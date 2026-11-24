import { ErroDeBanco } from "@/db/erro-banco";
import { MENSAGENS } from "./schemas-painel";

// Traduz a recusa do banco nas mensagens do contrato de copy (ACER-08, ACER-09). O banco é quem decide; este arquivo só
// escolhe o texto. NADA do erro original chega ao navegador (T-02-45): sai a mensagem fixa, nunca `message`, consulta
// ou parâmetros. Fica fora do arquivo `"use server"` porque um arquivo de Server Actions só exporta ações.

export type TraducaoDeErro =
  /** 42501: a sessão perdeu o segundo fator; a ação redireciona para a tela dele. */
  | { tipo: "segundo-fator" }
  /** 23505 em criar: o endereço já existe; a ação tenta outro. */
  | { tipo: "slug-repetido" }
  | { tipo: "campo"; campo: string; mensagem: string }
  | { tipo: "geral"; mensagem: string };

const RESTRICAO_ACER09 = "fonte_obra_protegida_sem_texto_integral";
const RESTRICAO_LICENCA = "fonte_texto_integral_exige_licenca_e_origem";

export function traduzirErroDoPainel(erro: unknown): TraducaoDeErro {
  if (!(erro instanceof ErroDeBanco)) return { tipo: "geral", mensagem: MENSAGENS.servidor };
  switch (erro.code) {
    case "42501":
      return { tipo: "segundo-fator" };
    case "23505":
      return erro.constraint === "fonte_slug_unico"
        ? { tipo: "slug-repetido" }
        : { tipo: "geral", mensagem: MENSAGENS.servidor };
    case "23514":
      // A restrição de licença tem nome próprio. A de ACER-09 e os gatilhos de texto (sem nome de restrição) são a mesma
      // regra. Qualquer outra restrição de linha não é nenhuma das duas e não leva a mensagem delas.
      if (erro.constraint === RESTRICAO_LICENCA)
        return { tipo: "campo", campo: "licenca", mensagem: MENSAGENS.licenca };
      if (erro.constraint === undefined || erro.constraint === RESTRICAO_ACER09)
        return { tipo: "campo", campo: "obra_protegida", mensagem: MENSAGENS.obraProtegida };
      return { tipo: "geral", mensagem: MENSAGENS.servidor };
    case "40001":
      return { tipo: "geral", mensagem: MENSAGENS.revisao };
    case "23503":
      return { tipo: "campo", campo: "secoes", mensagem: MENSAGENS.paragrafoCitado };
    case "P0006":
      return { tipo: "campo", campo: "tradicao", mensagem: MENSAGENS.tradicao };
    case "P0003":
    case "P0004":
      return { tipo: "geral", mensagem: MENSAGENS.doArquivo };
    default:
      return { tipo: "geral", mensagem: MENSAGENS.servidor };
  }
}

export { RESTRICAO_ACER09, RESTRICAO_LICENCA };
