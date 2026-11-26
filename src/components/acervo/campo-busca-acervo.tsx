"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHAVE_DO_TERMO_PENDENTE, TERMO_DA_BUSCA_MAX } from "@/modules/acervo/busca-limites";

// Campo "Buscar no Acervo" da lista (tela 2). O termo vai para a tela de busca SEM passar pela URL (PRIV-04): fica
// na aba (`sessionStorage`) e a tela de busca o lê e o apaga ao abrir, e ali a busca é um POST. `method="post"` com
// `action` no formulário é o cinto: se o navegador o enviar antes de a página hidratar, o termo vai no corpo da
// requisição e nunca como `?q=`.

export function CampoBuscaAcervo() {
  const roteador = useRouter();
  const [termo, setTermo] = useState("");
  // O botão só vale depois de a página hidratar: enviado antes, o formulário faz um POST nativo que ninguém trata e o termo se
  // perde sem aviso (revisão cruzada da fase, plano 02-24). Desabilitado, nem o clique nem o Enter enviam.
  const [pronto, setPronto] = useState(false);
  useEffect(() => setPronto(true), []);

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const limpo = termo.trim();
    try {
      if (limpo !== "") window.sessionStorage.setItem(CHAVE_DO_TERMO_PENDENTE, limpo);
    } catch {
      // Sem armazenamento da aba: a tela de busca abre com o campo vazio.
    }
    roteador.push("/acervo/busca");
  }

  return (
    <search>
      <form method="post" action="/acervo/busca" onSubmit={enviar} className="flex flex-col gap-2">
        <label htmlFor="acervo-lista-termo" className="text-label">
          Buscar no Acervo
        </label>
        <div className="flex gap-3">
          <Input
            id="acervo-lista-termo"
            type="search"
            name="termo"
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            maxLength={TERMO_DA_BUSCA_MAX}
            autoComplete="off"
            enterKeyHint="search"
            className="flex-1"
          />
          <Button type="submit" variant="secondary" disabled={!pronto}>
            Buscar
          </Button>
        </div>
      </form>
    </search>
  );
}
