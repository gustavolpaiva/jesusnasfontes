"use client";

import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";

// 500: mesma estrutura da 404. Nunca mostra a mensagem do erro (pode carregar texto privado).
export default function Erro({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AppShell>
      <div className="coluna-leitura flex flex-col items-start gap-6">
        <h1 className="text-display">Algo deu errado</h1>
        <p className="text-leitura">
          Não conseguimos abrir esta página. Tente de novo. Se continuar, avise quem organiza o
          grupo.
        </p>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Button variant="primary" onClick={() => reset()}>
            Tentar de novo
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/trilhas">Ir para as Trilhas</Link>
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
