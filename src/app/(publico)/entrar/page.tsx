import { StatusMessage } from "@/components/estado/status-message";
import { LimparRascunhos } from "@/modules/caderno/limpar-rascunhos";
import { lerSessao } from "@/modules/identidade/sessao";
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
  else if (motivo === "segundo-fator")
    aviso = {
      tipo: "erro",
      texto: "Muitas tentativas erradas. Sua sessão foi encerrada. Entre de novo.",
    };
  else if (semAcesso === "1")
    aviso = {
      tipo: "erro",
      texto: "Esta conta não tem mais acesso. Fale com quem organiza o grupo.",
    };

  // O marcador na URL não prova que a pessoa saiu: um link ou favorito com `?saiu=1`, aberto por quem continua entrado,
  // apagaria os rascunhos que ainda não foram enviados. Só limpa quem de fato não tem sessão (a saída e o apagar da
  // conta encerram a sessão antes de chegar aqui).
  const semSessao = (await lerSessao()) === null;
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      {/* Sair e apagar a conta levam o rascunho de Anotação deste aparelho embora (aviso de privacidade). */}
      <LimparRascunhos apagar={semSessao && (saiu === "1" || apagada === "1")} />
      {aviso ? <StatusMessage tipo={aviso.tipo}>{aviso.texto}</StatusMessage> : null}
      <FormularioEntrada />
    </div>
  );
}
