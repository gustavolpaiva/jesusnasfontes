"use client";

import { useEffect, useState } from "react";

type Estado = "online" | "offline" | "voltou";

// Faixa no topo do main. Sem fechar à mão. Ao voltar a conexão vira "Conexão de volta." por 5 s.
export function OfflineBanner() {
  const [estado, setEstado] = useState<Estado>("online");

  useEffect(() => {
    if (!navigator.onLine) setEstado("offline");
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const aoCair = () => {
      clearTimeout(temporizador);
      setEstado("offline");
    };
    const aoVoltar = () => {
      setEstado("voltou");
      clearTimeout(temporizador);
      temporizador = setTimeout(() => setEstado("online"), 5000);
    };
    window.addEventListener("offline", aoCair);
    window.addEventListener("online", aoVoltar);
    return () => {
      window.removeEventListener("offline", aoCair);
      window.removeEventListener("online", aoVoltar);
      clearTimeout(temporizador);
    };
  }, []);

  return (
    // A região existe sempre, para o leitor de tela anunciar a mudança de texto.
    <div role="status" aria-live="polite" data-estado={estado}>
      {estado === "offline" ? (
        <p className="text-ui mb-6 border border-l-4 border-input border-l-ink px-4 py-3">
          Sem conexão. Sua Anotação continua sendo guardada neste aparelho. O resto precisa de
          internet.
        </p>
      ) : null}
      {estado === "voltou" ? (
        <p className="text-ui mb-6 border border-l-4 border-input border-l-ink px-4 py-3">
          Conexão de volta.
        </p>
      ) : null}
    </div>
  );
}
