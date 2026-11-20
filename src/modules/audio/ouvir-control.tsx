"use client";

import { Pause, Play, Square } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOuvir } from "./contexto";

// Botão "Ouvir" (tela 8 do contrato). Dois lugares usam este controle, o Estudo e o texto bíblico, e
// ambos falam com o mesmo leitor: iniciar um interrompe o outro. Os botões não mudam de lugar entre os
// estados: "Ouvir", "Pausar" e "Continuar" são o MESMO botão, com a mesma largura mínima, e "Parar"
// aparece à direita. Nada toca sozinho: a leitura só começa no toque.

export const MENSAGENS_DO_OUVIR = {
  procurando: "Procurando voz em português…",
  semVoz:
    "Seu aparelho não tem voz em português. Instale uma nas configurações de voz do aparelho para ouvir.",
  soPortugal:
    "Seu aparelho só tem voz em português de Portugal. A leitura funciona, mas o sotaque pode soar diferente.",
  semSuporte: "Este navegador não lê textos em voz alta. Tente outro navegador.",
  pausado: "Pausado",
  falha: "A leitura em voz parou. Toque em Ouvir para recomeçar.",
} as const;

type Props = {
  /** Identifica o controle no leitor compartilhado ("estudo" ou "texto"). */
  id: "estudo" | "texto";
  /** O texto a ler, já dividido em trechos (ver `dividirEmTrechos`). */
  trechos: readonly string[];
  /** Nome acessível do botão parado: "Ouvir o Estudo" ou "Ouvir o texto bíblico". */
  nome: string;
  /** Rótulo visível do botão parado: "Ouvir" ou "Ouvir o texto". */
  rotulo: string;
  /** A meta enquanto lê: "Lendo o Estudo" ou "Lendo o texto bíblico". */
  meta: string;
  /** Largura mínima do botão da esquerda, igual nos três estados, para ele nunca mudar de lugar. */
  larguraDoBotao: string;
  /** Algo ao lado dos botões (a duração do Estudo). */
  children?: ReactNode;
  className?: string;
};

export function OuvirControl({
  id,
  trechos,
  nome,
  rotulo,
  meta,
  larguraDoBotao,
  children,
  className,
}: Props) {
  const { instantaneo: s, iniciar, pausar, continuar, parar } = useOuvir();
  const idDaMensagem = useId();
  const principal = useRef<HTMLButtonElement>(null);

  const meu = s.dono === id;
  const lendo = meu && s.estado === "lendo";
  const pausado = meu && s.estado === "pausado";
  const falhou = meu && s.estado === "falha";
  const semVoz = s.estado === "sem-voz";
  const semSuporte = s.estado === "sem-suporte";
  const procurando = s.estado === "procurando";
  const bloqueado = semVoz || semSuporte || procurando;

  const mensagem = procurando
    ? MENSAGENS_DO_OUVIR.procurando
    : semVoz
      ? MENSAGENS_DO_OUVIR.semVoz
      : semSuporte
        ? MENSAGENS_DO_OUVIR.semSuporte
        : lendo
          ? meta
          : pausado
            ? MENSAGENS_DO_OUVIR.pausado
            : null;
  const avisoDePortugal = s.avisoPortugal && !bloqueado;

  const aoTocar = () => {
    // `aria-disabled` não bloqueia o clique sozinho: o botão segue focável e a explicação fica à vista.
    if (bloqueado) return;
    if (lendo) pausar();
    else if (pausado) continuar();
    else iniciar(trechos, id);
  };

  const Icone = lendo ? Pause : Play;
  const rotuloAtual = lendo ? "Pausar" : pausado ? "Continuar" : rotulo;

  return (
    <div data-slot="ouvir" data-ouvir={id} className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          ref={principal}
          type="button"
          variant="secondary"
          className={larguraDoBotao}
          aria-disabled={bloqueado || undefined}
          aria-label={lendo || pausado ? undefined : nome}
          aria-describedby={bloqueado ? idDaMensagem : undefined}
          data-estado={lendo ? "lendo" : pausado ? "pausado" : "ocioso"}
          onClick={aoTocar}
        >
          <Icone aria-hidden="true" strokeWidth={1.5} />
          {rotuloAtual}
        </Button>
        {lendo || pausado ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              parar();
              principal.current?.focus();
            }}
          >
            <Square aria-hidden="true" strokeWidth={1.5} />
            Parar
          </Button>
        ) : null}
        {children}
      </div>
      <p
        id={idDaMensagem}
        aria-live="polite"
        data-ouvir-mensagem
        className="text-meta text-ink-muted [&:not(:empty)]:mt-2"
      >
        {mensagem}
        {mensagem && avisoDePortugal ? ". " : null}
        {avisoDePortugal ? MENSAGENS_DO_OUVIR.soPortugal : null}
      </p>
      {falhou ? (
        <StatusMessage tipo="aviso" className="mt-3">
          {MENSAGENS_DO_OUVIR.falha}
        </StatusMessage>
      ) : null}
    </div>
  );
}
