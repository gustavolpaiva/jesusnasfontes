"use client";

import { useEffect } from "react";

// Leva a janela ao parágrafo do endereço (`#p-18.63`) quando o texto chega DEPOIS de o navegador tentar rolar.
// O navegador só rola até o fragmento uma vez, no carregamento; a página da Fonte entra por streaming (há
// esqueleto antes do texto), e então o link de uma Citação ficava no topo da seção. Não renderiza nada.
// Respeita o `scroll-margin-top` do parágrafo e não anima (o movimento reduzido vale sem checagem extra).

export function RolarAteAncora() {
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash);
    } catch {
      return;
    }
    if (!id.startsWith("p-")) return;
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);
  return null;
}
