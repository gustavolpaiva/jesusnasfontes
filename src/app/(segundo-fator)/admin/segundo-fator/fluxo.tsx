"use client";

import { useActionState } from "react";
import { ativarSegundoFator, type ResultadoSegundoFator } from "@/modules/identidade/segundo-fator";
import { Cadastro } from "./cadastro";
import { CodigosRecuperacao } from "./codigos-recuperacao";
import { Verificacao } from "./verificacao";

const INICIAL: ResultadoSegundoFator = {};

export type Modo = "cadastro" | "verificacao" | "verificado";

// O estado da ativação mora aqui, no topo, para continuar vivo depois do recarregamento que a ação
// provoca (a sessão passa a verificada e a página muda de modo, mas esta árvore é a mesma).
export function FluxoSegundoFator({
  modo,
  material,
}: {
  modo: Modo;
  material: { uri: string; chave: string } | null;
}) {
  const [ativacao, ativar, ativando] = useActionState(ativarSegundoFator, INICIAL);
  if (ativacao.codigos) return <CodigosRecuperacao codigos={ativacao.codigos} />;
  if (modo === "cadastro") {
    return <Cadastro material={material} estado={ativacao} acao={ativar} pendente={ativando} />;
  }
  if (modo === "verificacao") return <Verificacao />;
  return (
    <div className="coluna-leitura flex flex-col gap-4">
      <h1 className="text-display">Segundo fator</h1>
      <p className="text-leitura">Você já confirmou o segundo fator nesta sessão.</p>
      <a href="/admin" className="text-ui min-h-11 self-start underline">
        Ir para a administração
      </a>
    </div>
  );
}
