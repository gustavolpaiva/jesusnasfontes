"use client";

import { useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";

type Estado = "ocioso" | "preparando" | "erro" | "conexao";

// Baixa o JSON de GET /conta/exportar como arquivo. Sem conexão não há fila: mostra o erro de conexão.
export function BaixarDados() {
  const [estado, setEstado] = useState<Estado>("ocioso");

  async function baixar() {
    setEstado("preparando");
    try {
      const resposta = await fetch("/conta/exportar", { cache: "no-store" });
      const tipo = resposta.headers.get("content-type") ?? "";
      if (!resposta.ok || !tipo.includes("application/json")) {
        setEstado("erro");
        return;
      }
      const url = URL.createObjectURL(await resposta.blob());
      const ancora = document.createElement("a");
      ancora.href = url;
      ancora.download = "jesus-nas-fontes-meus-dados.json";
      document.body.append(ancora);
      ancora.click();
      ancora.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setEstado("ocioso");
    } catch {
      setEstado(navigator.onLine ? "erro" : "conexao");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="secondary"
        className="self-start"
        onClick={baixar}
        pendente={estado === "preparando"}
        rotuloPendente="Preparando o arquivo…"
      >
        Baixar meus dados
      </Button>
      {estado === "erro" ? (
        <StatusMessage tipo="erro">Não foi possível gerar o arquivo. Tente de novo.</StatusMessage>
      ) : null}
      {estado === "conexao" ? (
        <StatusMessage tipo="erro">
          Sem conexão. Tente de novo quando a conexão voltar.
        </StatusMessage>
      ) : null}
    </div>
  );
}
