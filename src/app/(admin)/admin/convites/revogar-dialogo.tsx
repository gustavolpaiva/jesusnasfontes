"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  email: string;
  estado: "pendente" | "aceito";
  // Chamado ao confirmar; o diálogo fecha quando a promessa termina (certo ou errado: o resultado
  // aparece na lista, não aqui).
  aoConfirmar: () => Promise<void>;
};

// O foco inicial é "Cancelar" (o AlertDialog do Radix o faz): revogar nunca é o padrão do teclado.
// O corpo do texto depende do estado: o convite Aceito diz que a pessoa sai de todos os aparelhos e
// que os dados dela ficam.
export function RevogarDialogo({ email, estado, aoConfirmar }: Props) {
  const [aberto, setAberto] = useState(false);
  const [pendente, setPendente] = useState(false);

  async function confirmar() {
    setPendente(true);
    try {
      await aoConfirmar();
    } finally {
      setPendente(false);
      setAberto(false);
    }
  }

  return (
    <AlertDialog open={aberto} onOpenChange={(valor) => !pendente && setAberto(valor)}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="secondary" aria-label={`Revogar convite de ${email}`}>
          Revogar
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Revogar o convite?</AlertDialogTitle>
          <AlertDialogDescription className="[overflow-wrap:anywhere]">
            {estado === "aceito"
              ? `${email} sai de todos os aparelhos e não consegue mais entrar. Os dados da pessoa não são apagados.`
              : `${email} não poderá mais entrar com este convite.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Cancelar vem primeiro no DOM: a ordem de Tab é a visual. */}
        <AlertDialogFooter className="flex-col sm:flex-row">
          <AlertDialogCancel disabled={pendente}>Cancelar</AlertDialogCancel>
          <Button
            type="button"
            variant="destructiveSolid"
            pendente={pendente}
            rotuloPendente="Revogando…"
            onClick={confirmar}
          >
            Revogar convite
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
