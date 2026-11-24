// Vocabulário FECHADO de licença do texto de uma Fonte e o texto que cada código mostra na tela. O texto de
// licença é jurídico e não pode variar pela redação de quem preenche o YAML: o contrato (schemas.ts) só aceita
// estes códigos e a tela só mostra o texto daqui. A coluna `licenca` do banco segue texto livre; quem fecha
// a lista é o zod, na carga.

export const CODIGOS_FIXOS_DE_LICENCA = [
  "dp-anterior-1929",
  "dp-dedicado",
  "dp-declarado-pela-origem",
  "edicao-digital-cc-by-sa-e-traducao-dp",
  "edicao-digital-cc-by-sa-4-e-traducao-dp",
] as const;

// Licença aberta moderna: `aberta-<código>` (ex.: `aberta-cc-by-4.0`), com o código em minúsculas, números,
// hífens e pontos.
const ABERTA = /^aberta-([a-z0-9]+(?:[-.][a-z0-9]+)*)$/;

export type DadosDaTraducao = { tradutor?: string | null; ano?: number | null };

const EDICAO_DIGITAL: Record<string, string> = {
  "edicao-digital-cc-by-sa-e-traducao-dp": "CC BY-SA",
  "edicao-digital-cc-by-sa-4-e-traducao-dp": "CC BY-SA 4.0",
};

export function licencaValida(codigo: string): boolean {
  return (CODIGOS_FIXOS_DE_LICENCA as readonly string[]).includes(codigo) || ABERTA.test(codigo);
}

/** A licença da edição digital já nomeia o tradutor e o ano: o crédito não repete "Tradução de …". */
export function licencaCitaATraducao(codigo: string): boolean {
  return codigo in EDICAO_DIGITAL;
}

/** O código de licença aberta em letras de licença: `cc-by-4.0` vira "CC BY 4.0". */
function codigoAbertoParaTexto(restante: string): string {
  return restante.replace(/-/g, " ").toUpperCase();
}

/**
 * Texto da licença para a tela. Código desconhecido aparece como está (nunca some); o contrato impede que
 * um código assim chegue ao banco pela carga.
 */
export function textoDaLicenca(codigo: string, traducao: DadosDaTraducao): string {
  switch (codigo) {
    case "dp-anterior-1929":
      return "Domínio público (tradução anterior a 1929)";
    case "dp-dedicado":
      return "Domínio público, dedicado pelo tradutor";
    case "dp-declarado-pela-origem":
      return "Domínio público, como declara a origem";
    case "edicao-digital-cc-by-sa-e-traducao-dp":
    case "edicao-digital-cc-by-sa-4-e-traducao-dp": {
      const quem = [traducao.tradutor, traducao.ano == null ? null : String(traducao.ano)]
        .filter(Boolean)
        .join(", ");
      return `Edição digital: ${EDICAO_DIGITAL[codigo]}.${quem ? ` Tradução de ${quem}: domínio público.` : " Tradução em domínio público."}`;
    }
    default: {
      const aberta = ABERTA.exec(codigo);
      return aberta?.[1] ? codigoAbertoParaTexto(aberta[1]) : codigo;
    }
  }
}
