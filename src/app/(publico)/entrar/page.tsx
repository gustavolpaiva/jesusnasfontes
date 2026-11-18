import { StatusMessage } from "@/components/estado/status-message";
import { FormularioEntrada } from "./formulario-email";

// Primeira tela de quem ainda não entrou. O estado do formulário (etapa 1 e 2) mora no cliente.
export default async function PaginaEntrar({
  searchParams,
}: {
  searchParams: Promise<{ motivo?: string; saiu?: string; apagada?: string; semAcesso?: string }>;
}) {
  const { motivo, saiu, apagada, semAcesso } = await searchParams;
  let aviso: { tipo: "informacao" | "erro"; texto: string } | null = null;
  if (saiu === "1") aviso = { tipo: "informacao", texto: "Você saiu." };
  else if (apagada === "1") aviso = { tipo: "informacao", texto: "Sua conta foi apagada." };
  else if (motivo === "sessao")
    aviso = { tipo: "informacao", texto: "Sua sessão terminou. Entre de novo." };
  else if (semAcesso === "1")
    aviso = {
      tipo: "erro",
      texto: "Esta conta não tem mais acesso. Fale com quem organiza o grupo.",
    };

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      {aviso ? <StatusMessage tipo={aviso.tipo}>{aviso.texto}</StatusMessage> : null}
      <FormularioEntrada />
    </div>
  );
}
