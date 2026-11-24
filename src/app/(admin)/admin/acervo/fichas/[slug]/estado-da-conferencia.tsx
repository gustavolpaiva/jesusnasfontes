"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { RecusaDaConferencia, RecusaDaVerificacao } from "@/modules/acervo/painel-fichas";

// O estado do que está no ar na tela de uma ficha (plano 02-18). Duas regras que vêm das quatro rodadas de revisão do
// plano 17 e valem aqui desde o começo:
//   - TODA escrita passa por `executar`: só uma por vez (a trava é um `ref`, síncrona, porque dois cliques no mesmo
//     quadro leriam o mesmo `useState` ainda sem a atualização), e enquanto ela está no ar os botões de conferir e de
//     verificar ficam `aria-disabled` (continuam focáveis, não somem) e recusam o clique;
//   - nada de estado de lista no cliente: a lista de itens e o que está conferido vêm SEMPRE do servidor (a ação
//     revalida a página), então nenhuma resposta é casada com uma linha por posição. O cliente só guarda o que é dele:
//     a recusa a mostrar e o pedido de foco.

export type RecusaNaTela = RecusaDaConferencia | RecusaDaVerificacao;

type Valor = {
  /** Há uma escrita no ar (a ação, e a página nova ainda sendo aplicada). */
  ocupado: boolean;
  recusa: RecusaNaTela | null;
  /** Roda a escrita se não há outra no ar; devolve `undefined` quando recusou por haver outra. */
  executar: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  mostrarRecusa: (r: RecusaNaTela | null) => void;
  /** Depois que a página nova for aplicada, leva o foco ao próximo botão "Conferi no livro" ou, sem ele, ao de verificar. */
  pedirFocoNoProximo: () => void;
};

const Contexto = createContext<Valor | null>(null);

export function useConferencia(): Valor {
  const v = useContext(Contexto);
  if (!v) throw new Error("useConferencia fora do ProvedorDeConferencia");
  return v;
}

const PROXIMO = '[data-slot="conferir-botao"]:not([aria-disabled="true"])';
const VERIFICAR = '[data-slot="verificar-botao"]';

/** Leva o foco ao primeiro botão "Conferi no livro" que ainda existe; devolve se achou. */
export function focarPrimeiraPaginaAConferir(): boolean {
  const alvo = document.querySelector<HTMLElement>(PROXIMO);
  if (!alvo) return false;
  alvo.focus();
  return true;
}

export function ProvedorDeConferencia({ children }: { children: ReactNode }) {
  const [pendente, iniciar] = useTransition();
  const [recusa, setRecusa] = useState<RecusaNaTela | null>(null);
  const [focoPedido, setFocoPedido] = useState(false);
  const emVoo = useRef(false);

  const executar = useCallback(<T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (emVoo.current) return Promise.resolve(undefined);
    emVoo.current = true;
    return new Promise<T | undefined>((resolver) => {
      // A transição só termina quando a ação voltou E a página revalidada foi aplicada: é quando o botão de uma
      // página já conferida some e o foco pode ir para o próximo.
      iniciar(async () => {
        try {
          resolver(await fn());
        } catch {
          // Quem chama trata a falha de rede dentro de `fn` e devolve a recusa; aqui só se solta a trava.
          resolver(undefined);
        } finally {
          emVoo.current = false;
        }
      });
    });
  }, []);

  useEffect(() => {
    if (!focoPedido || pendente) return;
    setFocoPedido(false);
    if (!focarPrimeiraPaginaAConferir()) document.querySelector<HTMLElement>(VERIFICAR)?.focus();
  }, [focoPedido, pendente]);

  const valor = useMemo<Valor>(
    () => ({
      ocupado: pendente,
      recusa,
      executar,
      mostrarRecusa: setRecusa,
      pedirFocoNoProximo: () => setFocoPedido(true),
    }),
    [pendente, recusa, executar],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}
