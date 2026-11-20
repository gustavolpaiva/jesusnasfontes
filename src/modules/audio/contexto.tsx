"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { INSTANTANEO_INICIAL, type Instantaneo, LeitorEmVoz } from "./leitor";
import type { FalaLike, SinteseLike } from "./vozes";

// Um leitor por página: o controle do Estudo e o do texto bíblico falam com o MESMO `LeitorEmVoz`,
// então iniciar um interrompe o outro. A fala termina quando a página sai (desmontagem, troca de rota,
// recarga ou fechamento): nada fica falando sozinho depois de a pessoa ir embora.

type Valor = {
  instantaneo: Instantaneo;
  iniciar: (trechos: readonly string[], dono: string) => boolean;
  pausar: () => void;
  continuar: () => void;
  parar: () => void;
};

const Contexto = createContext<Valor | null>(null);

function sinteseDoNavegador(): SinteseLike | null {
  if (typeof window === "undefined") return null;
  const s = (window as unknown as { speechSynthesis?: SinteseLike }).speechSynthesis;
  return s ?? null;
}

function criarFalaDoNavegador(texto: string): FalaLike {
  return new SpeechSynthesisUtterance(texto) as unknown as FalaLike;
}

export function OuvirProvider({ children }: { children: ReactNode }) {
  const [leitor] = useState(
    () => new LeitorEmVoz({ sintese: sinteseDoNavegador, criarFala: criarFalaDoNavegador }),
  );
  const instantaneo = useSyncExternalStore(
    leitor.assinar,
    leitor.instantaneo,
    () => INSTANTANEO_INICIAL,
  );

  useEffect(() => {
    // Procurar a voz não fala nada; só deixa o botão saber, sem a pessoa tocar, se há voz em português.
    void leitor.preparar();
    const sair = () => leitor.parar();
    window.addEventListener("pagehide", sair);
    return () => {
      window.removeEventListener("pagehide", sair);
      leitor.parar();
    };
  }, [leitor]);

  const valor = useMemo<Valor>(
    () => ({
      instantaneo,
      iniciar: (trechos, dono) => leitor.iniciar(trechos, dono),
      pausar: () => leitor.pausar(),
      continuar: () => leitor.continuar(),
      parar: () => leitor.parar(),
    }),
    [leitor, instantaneo],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useOuvir(): Valor {
  const valor = useContext(Contexto);
  if (!valor) throw new Error("useOuvir fora do OuvirProvider");
  return valor;
}
