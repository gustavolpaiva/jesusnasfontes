"use client";

import { useEffect } from "react";
import { apagarTodosRascunhos } from "./rascunho";

// Montado em `/entrar`: quem chega depois de SAIR (`saiu=1`) ou de apagar a conta (`apagada=1`) não deixa
// rascunho de Anotação neste aparelho. O aviso de privacidade promete isso (seção "Neste aparelho"). Sessão
// que só expirou (`motivo=sessao`) NÃO apaga: a pessoa não saiu, e o texto ainda não enviado é dela.
// Não renderiza nada.
export function LimparRascunhos({ apagar }: { apagar: boolean }) {
  useEffect(() => {
    if (apagar) apagarTodosRascunhos();
  }, [apagar]);
  return null;
}
