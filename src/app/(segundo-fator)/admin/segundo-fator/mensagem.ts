import type { ResultadoSegundoFator } from "@/modules/identidade/segundo-fator";

// Texto do contrato (01-UI-SPEC, "Admin: segundo fator"). O componente de mensagem põe "Erro." antes.
export function mensagemDoResultado(
  estado: ResultadoSegundoFator,
  via: "aplicativo" | "recuperacao",
): string | null {
  if (estado.resultado === "falha") return "Não conseguimos conferir agora. Tente de novo.";
  if (estado.resultado !== "incorreto") return null;
  const n = estado.restantes ?? 0;
  const restam = n === 1 ? "Resta 1 tentativa." : `Restam ${n} tentativas.`;
  const confira = via === "aplicativo" ? "Confira o aplicativo" : "Confira o código";
  return `Código incorreto. ${confira} e tente de novo. ${restam}`;
}
