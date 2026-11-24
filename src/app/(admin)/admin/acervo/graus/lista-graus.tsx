"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { mensagemDaFalha } from "@/app/(admin)/admin/convites/mensagens";
import { ChipDaProposta } from "@/components/acervo/chip-da-proposta";
import { PropostaGrau } from "@/components/acervo/proposta-grau";
import { ROTULO_DO_GRAU, SeloGrau } from "@/components/acervo/selo-grau";
import { StatusMessage } from "@/components/estado/status-message";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Algarismos } from "@/components/ui/algarismos";
import { aprovarGrauAction } from "@/modules/acervo/acoes-graus";
import type { PropostaDoPainel } from "@/modules/acervo/consultas-graus";
import type { GrauDeCerteza } from "@/modules/acervo/estado-da-proposta";
import {
  mensagemDeSucesso,
  type RecusaDaAprovacao,
  type ResultadoDeAprovar,
} from "@/modules/acervo/painel-graus";

// A lista de propostas (UI-SPEC tela 13): um acordeão de abertura múltipla, uma proposta por item. As lições do painel de
// fichas valem desde o começo:
//   - o cliente NÃO guarda a lista: ela vem do servidor, e a ação a revalida; nada é casado por posição, só pelo id da
//     Afirmação (`afirmacaoId`), que também é a chave e o valor de cada item;
//   - UMA escrita por vez em toda a lista (a trava é um `ref`, síncrona: dois cliques no mesmo quadro leriam o mesmo
//     estado), e enquanto ela está no ar todos os botões de aprovar ficam `aria-disabled` e recusam o clique;
//   - o que o cliente guarda é só o que é dele: a mensagem de sucesso, as recusas por id e qual item está salvando.
// Sem id gerado no cliente: a hidratação usa só o que o servidor mandou (e `useId` do React, estável nos dois lados).

type Props = { propostas: PropostaDoPainel[] };

export function ListaGraus({ propostas }: Props) {
  const roteador = useRouter();
  const [pendente, iniciar] = useTransition();
  const emVoo = useRef(false);
  const [salvandoId, setSalvandoId] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<{ id: string; grau: GrauDeCerteza } | null>(null);
  const [recusas, setRecusas] = useState<Record<string, RecusaDaAprovacao>>({});
  const aviso = useRef<HTMLDivElement>(null);

  const chave = sucesso ? `ok-${sucesso.id}-${sucesso.grau}` : "";
  // A mensagem nova recebe o foco: quem usa leitor de tela é avisado, e quem olha a tela vê onde.
  useEffect(() => {
    if (chave) aviso.current?.focus();
  }, [chave]);

  async function aprovar(p: PropostaDoPainel, grau: GrauDeCerteza) {
    if (emVoo.current) return;
    emVoo.current = true;
    setSucesso(null);
    setRecusas((r) => {
      const { [p.afirmacaoId]: _fora, ...resto } = r;
      return resto;
    });
    setSalvandoId(p.afirmacaoId);
    const resultado = await new Promise<ResultadoDeAprovar | undefined>((resolver) => {
      // A transição só termina quando a ação voltou E a lista revalidada foi aplicada.
      iniciar(async () => {
        try {
          resolver(
            await aprovarGrauAction({
              afirmacaoId: p.afirmacaoId,
              textoHash: p.textoHash,
              citacoesHash: p.citacoesHash,
              grau,
            }),
          );
        } catch (erro) {
          const falha = mensagemDaFalha(erro, typeof navigator === "undefined" || navigator.onLine);
          resolver(
            falha
              ? {
                  ok: false,
                  afirmacaoId: p.afirmacaoId,
                  motivo: "servidor",
                  mensagem: falha.texto,
                }
              : undefined,
          );
        } finally {
          emVoo.current = false;
        }
      });
    });
    setSalvandoId(null);
    if (!resultado) return;
    if (resultado.ok) setSucesso({ id: resultado.afirmacaoId, grau: resultado.grau });
    else if (resultado.afirmacaoId) {
      const id = resultado.afirmacaoId;
      setRecusas((r) => ({ ...r, [id]: resultado }));
    }
  }

  const ocupado = pendente || salvandoId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={aviso}
        tabIndex={-1}
        className="outline-none"
        data-slot="aviso-dos-graus"
        aria-live="polite"
      >
        {sucesso ? (
          <StatusMessage tipo="sucesso">
            {mensagemDeSucesso(ROTULO_DO_GRAU[sucesso.grau])}
          </StatusMessage>
        ) : null}
      </div>
      <Accordion type="multiple" data-slot="lista-de-propostas" className="border-t border-border">
        {propostas.map((p) => (
          <AccordionItem
            key={p.afirmacaoId}
            value={p.afirmacaoId}
            data-afirmacao={p.afirmacaoId}
            data-estado={p.estado}
          >
            <AccordionTrigger className="items-start px-0 py-3" data-slot="proposta-gatilho">
              <span className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <span className="text-leitura frase-do-gatilho text-left [overflow-wrap:anywhere]">
                  {p.frase}
                </span>
                <span className="text-meta text-ink-muted [overflow-wrap:anywhere]">
                  <Algarismos>{`${p.estudoTitulo} · ${p.afirmacaoId}`}</Algarismos>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <ChipDaProposta estado={p.estado} grauAprovado={p.grauAprovado} />
                  <SeloGrau grau={p.grauProposto} />
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <PropostaGrau
                key={`${p.textoHash}:${p.citacoesHash}:${p.grauProposto}:${p.grauAprovado ?? ""}`}
                proposta={p}
                ocupado={ocupado}
                salvando={salvandoId === p.afirmacaoId}
                recusa={recusas[p.afirmacaoId] ?? null}
                aoAprovar={(grau) => void aprovar(p, grau)}
                aoRecarregar={() => roteador.refresh()}
              />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
