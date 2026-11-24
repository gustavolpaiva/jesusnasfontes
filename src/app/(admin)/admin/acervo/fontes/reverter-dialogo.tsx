"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
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
import { reverterAoArquivo } from "@/modules/acervo/acoes-fonte";
import { listaEmTexto, MENSAGENS, rotuloDoCampoEmConflito } from "@/modules/acervo/schemas-painel";

// Conflito com a carga (ACER-08): a última carga recusou a Fonte porque ela foi editada no painel. O aviso nomeia os
// campos, a ação "Reverter ao arquivo" abre um diálogo que nomeia o que se perde, e o foco inicial é "Cancelar"
// (o AlertDialog do Radix o faz): perder a edição nunca é o padrão do teclado.

export function AvisoDeConflito({ slug, campos }: { slug: string; campos: string[] }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [pendente, setPendente] = useState(false);
  const [falha, setFalha] = useState<string | null>(null);
  const nomes = listaEmTexto(campos.map(rotuloDoCampoEmConflito));

  async function confirmar() {
    setPendente(true);
    setFalha(null);
    try {
      const r = await reverterAoArquivo(slug, campos);
      if (r.ok) router.refresh();
      else setFalha(r.mensagem);
    } catch {
      setFalha(MENSAGENS.servidor);
    } finally {
      setPendente(false);
      setAberto(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-slot="aviso-de-conflito">
      <StatusMessage
        tipo="aviso"
        acao={
          <AlertDialog open={aberto} onOpenChange={(v) => !pendente && setAberto(v)}>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="secondary">
                Reverter ao arquivo
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
              <AlertDialogHeader>
                <AlertDialogTitle>Reverter ao arquivo?</AlertDialogTitle>
                <AlertDialogDescription className="[overflow-wrap:anywhere]">
                  {`Os campos ${nomes} voltam ao que está no arquivo. A edição feita no painel é perdida.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {/* Cancelar vem primeiro no DOM: a ordem de Tab é a visual. */}
              <AlertDialogFooter className="flex-col sm:flex-row">
                <AlertDialogCancel disabled={pendente}>Cancelar</AlertDialogCancel>
                <Button
                  type="button"
                  variant="destructiveSolid"
                  pendente={pendente}
                  rotuloPendente="Revertendo…"
                  onClick={confirmar}
                >
                  Reverter ao arquivo
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      >
        {`A última carga do arquivo recusou esta Fonte porque ela foi editada no painel: ${nomes}. Nada foi sobrescrito.`}
      </StatusMessage>
      <p className="text-meta text-ink-muted">
        Ou atualize o arquivo para refletir o painel e rode a carga de novo.
      </p>
      {falha ? <StatusMessage tipo="erro">{falha}</StatusMessage> : null}
    </div>
  );
}
