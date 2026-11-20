"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { fazerCheckIn } from "./acoes";
import { CheckoutSheet, type SessaoEncerrada } from "./checkout-sheet";
import { formatarDuracao } from "./formato";

// A faixa da Sessão (tela 6), parte do navegador: recebe tudo já formatado pelo servidor (fuso de São
// Paulo) e cuida dos botões e das mensagens. Sem conexão, check-in e check-out mostram o erro de conexão e
// não entram em fila.

const SEM_CONEXAO = "Sem conexão. Tente de novo quando a conexão voltar.";

export type EstadoDaFaixa =
  | { tipo: "aberta"; sessaoId: string; desde: string; estudo: string }
  | { tipo: "nenhuma"; ultima: string | null };

type Props = {
  estado: EstadoDaFaixa;
  /** O Estudo em que a pessoa está (nas telas de Estudo); nas Trilhas é `null`. */
  estudoAtual: { slug: string; titulo: string } | null;
};

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

export function FaixaDaSessao({ estado, estudoAtual }: Props) {
  const [mensagem, setMensagem] = useState<Mensagem>(null);
  const [pendente, iniciar] = useTransition();
  const lugarDaMensagem = useRef<HTMLDivElement>(null);

  // Depois do check-out o foco vai para a mensagem de sucesso: o botão que o abriu saiu de cena.
  useEffect(() => {
    if (mensagem?.tipo === "sucesso") lugarDaMensagem.current?.focus();
  }, [mensagem]);

  function abrir() {
    setMensagem(null);
    iniciar(async () => {
      let resultado: Awaited<ReturnType<typeof fazerCheckIn>>;
      try {
        resultado = await fazerCheckIn(estudoAtual ? { estudoSlug: estudoAtual.slug } : {});
      } catch {
        // A chamada nem chegou ao servidor: sem conexão. Não há fila.
        setMensagem({ tipo: "erro", texto: SEM_CONEXAO });
        return;
      }
      if (!resultado.ok) {
        setMensagem({
          tipo: "erro",
          texto: "Não conseguimos registrar o check-in. Tente de novo.",
        });
      }
    });
  }

  function aoEncerrar(e: SessaoEncerrada) {
    setMensagem({
      tipo: "sucesso",
      texto: `Sessão encerrada: ${formatarDuracao(e.minutos)}, de ${e.de} até ${e.ate}.`,
    });
  }

  return (
    <section aria-label="Sessão" data-slot="sessao-bar" className="flex flex-col gap-3">
      {/* Faixa de 48 px no mínimo, com filete inferior. A frase leva o tamanho do próprio texto: quando ela
          (com o botão) não cabe numa linha, ocupa a largura toda, quebra, e o botão desce para a linha
          seguinte, sem corte. */}
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule py-2">
        <p className="text-ui min-w-[min(100%,14rem)] flex-auto [overflow-wrap:anywhere]">
          {/* O rótulo é só visual: a região já se chama "Sessão" para o leitor de tela. */}
          <span aria-hidden="true" className="text-label mr-3 text-ink-muted">
            Sessão
          </span>
          <span>
            {estado.tipo === "aberta"
              ? `Sessão aberta desde ${estado.desde}, em ${estado.estudo}.`
              : estado.ultima
                ? `Última Sessão: ${estado.ultima}.`
                : "Nenhuma Sessão aberta."}
          </span>
        </p>
        {estado.tipo === "aberta" ? (
          <CheckoutSheet
            sessaoId={estado.sessaoId}
            estudoSlugAtual={estudoAtual?.slug ?? null}
            aoEncerrar={aoEncerrar}
          />
        ) : (
          <Button
            variant="secondary"
            pendente={pendente}
            rotuloPendente="Abrindo…"
            aria-label={
              estudoAtual ? `Fazer check-in no Estudo: ${estudoAtual.titulo}` : "Fazer check-in"
            }
            onClick={abrir}
          >
            Fazer check-in
          </Button>
        )}
      </div>
      {mensagem ? (
        <div ref={lugarDaMensagem} tabIndex={-1} className="outline-none">
          <StatusMessage tipo={mensagem.tipo}>{mensagem.texto}</StatusMessage>
        </div>
      ) : null}
    </section>
  );
}
