"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";

// Erro de carga da lista do Acervo: no próprio bloco, com a ação de tentar de novo (recarrega a página).
export function ErroDoAcervo() {
  const roteador = useRouter();
  const [pendente, iniciar] = useTransition();
  return (
    <StatusMessage
      tipo="erro"
      acao={
        <Button
          variant="secondary"
          pendente={pendente}
          rotuloPendente="Tentando…"
          onClick={() => iniciar(() => roteador.refresh())}
        >
          Tentar de novo
        </Button>
      }
    >
      Não conseguimos carregar o Acervo. Tente de novo.
    </StatusMessage>
  );
}
