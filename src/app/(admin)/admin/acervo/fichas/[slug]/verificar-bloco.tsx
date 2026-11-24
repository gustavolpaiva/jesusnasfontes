"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { verificarFichaAction } from "@/modules/acervo/acoes-ficha";
import { motivoDasPaginasFaltantes } from "@/modules/acervo/estado-da-ficha";
import {
  dataPorExtenso,
  MENSAGENS_FICHA,
  mensagemDeJaVerificada,
  mensagemDeVerificada,
  type ResultadoDeVerificar,
} from "@/modules/acervo/painel-fichas";
import { enderecoDoSegundoFator } from "@/modules/identidade/retorno-segundo-fator";
import { focarPrimeiraPaginaAConferir, useConferencia } from "./estado-da-conferencia";

// O bloco de ação no fim da ficha (UI-SPEC tela 12): "Marcar como verificada", SEMPRE focável. Com páginas faltando ele
// fica `aria-disabled`, o motivo vem em TEXTO ao lado e acioná-lo leva o foco à primeira página a conferir (nunca um
// botão `disabled` mudo). Com tudo conferido abre o `AlertDialog` (foco inicial em "Cancelar", que o Radix faz) e só a
// confirmação chama a ação. O hash enviado é o que esta tela LEU; o banco o confere e recusa o velho.

type Props = {
  slug: string;
  fichaId: string;
  hash: string;
  faltam: number;
  edicaoConfirmada: boolean;
  /** `verificada` na leitura do servidor: o bloco só mostra o resultado, sem botão. */
  verificadaEm: string | null;
};

export function VerificarBloco({
  slug,
  fichaId,
  hash,
  faltam,
  edicaoConfirmada,
  verificadaEm,
}: Props) {
  const { ocupado, recusa, executar, mostrarRecusa } = useConferencia();
  const roteador = useRouter();
  const [aberto, setAberto] = useState(false);
  const [agora, setAgora] = useState<{ quando: string; novidade: boolean } | null>(null);
  const aviso = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  // Fechou porque a ação respondeu (sucesso ou recusa): o foco vai à mensagem, não ao botão que abriu o diálogo.
  const focoNaMensagem = useRef(false);

  // A mensagem nova (sucesso ou recusa) recebe o foco: quem usa leitor de tela é avisado, e quem olha a tela vê onde.
  const chave = agora
    ? `ok-${agora.quando}`
    : recusa
      ? `recusa-${recusa.motivo}-${recusa.mensagem}`
      : "";
  useEffect(() => {
    if (chave) aviso.current?.focus();
  }, [chave]);

  const motivoFaltam = faltam > 0 ? motivoDasPaginasFaltantes(faltam) : null;
  const motivoEdicao = edicaoConfirmada ? null : MENSAGENS_FICHA.edicaoNaoConfirmada;
  const bloqueada = motivoFaltam !== null || motivoEdicao !== null;

  function aoAcionar() {
    if (ocupado) return;
    mostrarRecusa(null);
    setAgora(null);
    if (motivoFaltam) {
      focarPrimeiraPaginaAConferir();
      return;
    }
    if (motivoEdicao) {
      aviso.current?.focus();
      return;
    }
    setAberto(true);
  }

  async function confirmar() {
    const r = await executar(async (): Promise<ResultadoDeVerificar> => {
      try {
        return await verificarFichaAction({ slug, fichaId, hash });
      } catch (erro) {
        if (erro instanceof Error && "digest" in erro) throw erro;
        return { ok: false, motivo: "servidor", mensagem: MENSAGENS_FICHA.servidorVerificar };
      }
    });
    if (!r) return;
    focoNaMensagem.current = true;
    setAberto(false);
    if (r.ok) setAgora({ quando: r.verificadaEm, novidade: r.novidade });
    else mostrarRecusa(r);
  }

  const voltarAqui = `/admin/acervo/fichas/${slug}`;

  return (
    <section
      aria-labelledby="titulo-verificar"
      data-slot="bloco-de-verificacao"
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <h2 id="titulo-verificar" className="text-label text-ink-muted">
        Verificação
      </h2>

      {verificadaEm && !agora ? (
        <p className="text-ui" data-slot="ficha-verificada">
          Verificada em {dataPorExtenso(verificadaEm)}. Ela aparece para os Estudantes.
        </p>
      ) : null}

      <div
        id="aviso-da-acao"
        ref={aviso}
        tabIndex={-1}
        className="flex flex-col gap-3 outline-none"
        data-slot="aviso-da-acao"
      >
        {agora ? (
          <StatusMessage tipo={agora.novidade ? "sucesso" : "informacao"}>
            {agora.novidade
              ? mensagemDeVerificada(dataPorExtenso(agora.quando))
              : mensagemDeJaVerificada(dataPorExtenso(agora.quando))}
          </StatusMessage>
        ) : null}

        {recusa?.motivo === "segundo-fator" ? (
          <StatusMessage
            tipo="erro"
            acao={
              <Button asChild variant="secondary">
                <a href={enderecoDoSegundoFator("/admin/segundo-fator", voltarAqui)}>
                  {MENSAGENS_FICHA.confirmarSegundoFator}
                </a>
              </Button>
            }
          >
            {recusa.mensagem}
          </StatusMessage>
        ) : null}

        {recusa && (recusa.motivo === "mudou" || recusa.motivo === "faltam") ? (
          <StatusMessage
            tipo={recusa.motivo === "mudou" ? "erro" : "aviso"}
            acao={
              <Button type="button" variant="secondary" onClick={() => roteador.refresh()}>
                {MENSAGENS_FICHA.recarregar}
              </Button>
            }
          >
            {recusa.mensagem}
          </StatusMessage>
        ) : null}

        {recusa && (recusa.motivo === "servidor" || recusa.motivo === "invalido") ? (
          <StatusMessage tipo="erro">{recusa.mensagem}</StatusMessage>
        ) : null}

        {recusa?.motivo === "edicao" ? (
          <StatusMessage tipo="aviso">{recusa.mensagem}</StatusMessage>
        ) : null}

        {motivoEdicao && recusa?.motivo !== "edicao" && !verificadaEm ? (
          <StatusMessage tipo="aviso">{motivoEdicao}</StatusMessage>
        ) : null}
      </div>

      {verificadaEm || agora ? null : (
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="primary"
            ref={botao}
            data-slot="verificar-botao"
            aria-disabled={bloqueada || ocupado || undefined}
            aria-describedby={
              motivoFaltam ? "motivo-verificar" : motivoEdicao ? "aviso-da-acao" : undefined
            }
            onClick={aoAcionar}
          >
            Marcar como verificada
          </Button>
          {motivoFaltam ? (
            <p
              id="motivo-verificar"
              className="text-meta text-ink-muted"
              data-slot="motivo-verificar"
            >
              {motivoFaltam}
            </p>
          ) : null}
        </div>
      )}

      <AlertDialog open={aberto} onOpenChange={(valor) => !ocupado && setAberto(valor)}>
        <AlertDialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onCloseAutoFocus={(e) => {
            // O AlertDialog do Radix devolve o foco ao GATILHO (`AlertDialogTrigger`), e este diálogo é controlado, sem
            // gatilho: o foco ficaria no corpo. Cancelar e Esc voltam ao botão de verificar; só a resposta da ação o
            // desvia para a mensagem.
            e.preventDefault();
            if (focoNaMensagem.current) {
              focoNaMensagem.current = false;
              aviso.current?.focus();
            } else {
              botao.current?.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar como verificada?</AlertDialogTitle>
            <AlertDialogDescription>
              A ficha passa a aparecer para todos os Estudantes. Você confirma que leu a ficha
              inteira e conferiu cada página no livro. O seu nome fica só no registro interno do
              painel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Cancelar vem primeiro no DOM: o foco inicial do Radix e a ordem de Tab são os da leitura. */}
          <AlertDialogFooter className="flex-col sm:flex-row">
            <AlertDialogCancel disabled={ocupado}>Cancelar</AlertDialogCancel>
            <Button
              type="button"
              variant="primary"
              aria-disabled={ocupado || undefined}
              onClick={confirmar}
            >
              {ocupado ? "Marcando…" : "Marcar como verificada"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
