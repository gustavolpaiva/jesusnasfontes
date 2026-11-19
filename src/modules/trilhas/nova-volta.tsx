"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { comecarNovaVolta } from "./progresso";

// Fim da volta da Leitura contínua (TRIL-06): aparece quando as casas da volta estão todas concluídas.
// Sem confirmação, porque nada se apaga: as conclusões da volta ficam guardadas com o número dela.

const SEM_CONEXAO = "Sem conexão. Tente de novo quando a conexão voltar.";

export function NovaVolta({ volta }: { volta: number }) {
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  function comecar() {
    iniciar(async () => {
      setErro(null);
      try {
        const resultado = await comecarNovaVolta();
        if (!resultado.ok) setErro("Não foi possível começar a nova volta. Tente de novo.");
      } catch {
        // A chamada nem chegou ao servidor. Sem fila: a pessoa tenta de novo quando a conexão voltar.
        setErro(SEM_CONEXAO);
      }
    });
  }

  return (
    <section
      aria-labelledby="volta-terminada"
      className="mt-6 flex flex-col items-start gap-3 border-y border-rule py-6"
    >
      <h4 id="volta-terminada" className="text-heading">
        Você terminou a volta {volta}
      </h4>
      <p className="text-leitura">
        Na próxima volta, cada capítulo traz outras três perguntas. O que você concluiu na volta{" "}
        {volta} fica guardado.
      </p>
      <Button variant="primary" pendente={pendente} rotuloPendente="Começando…" onClick={comecar}>
        Começar a volta {volta + 1}
      </Button>
      {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
    </section>
  );
}

/** Erro de carga das Trilhas: no próprio bloco, com a ação de tentar de novo (recarrega a página). */
export function ErroDasTrilhas() {
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
      Não conseguimos carregar as Trilhas. Tente de novo.
    </StatusMessage>
  );
}
