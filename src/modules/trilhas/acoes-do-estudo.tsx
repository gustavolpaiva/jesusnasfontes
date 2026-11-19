"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { concluirEstudo, desmarcarConclusao, type ResultadoProgresso } from "./progresso";

// Ações no fim do Estudo (TRIL-04). "Anterior" e "Marcar como concluído" na mesma linha; depois de
// concluir, "Próximo" e a ação ghost "Desmarcar conclusão", e a mensagem de estado em `role="status"`.
// Nada avança sozinho para o Estudo seguinte. Sem conexão, o erro de conexão aparece e nada fica em
// fila: a pessoa tenta de novo quando a conexão voltar.

type Vizinho = { slug: string } | null;

type Props = {
  estudoId: string;
  anterior: Vizinho;
  proximo: Vizinho;
  concluidoInicial: boolean;
};

type Mensagem = { tipo: "sucesso"; texto: string } | { tipo: "erro"; texto: string } | null;

const SEM_CONEXAO = "Sem conexão. Tente de novo quando a conexão voltar.";
const ERRO_AO_MARCAR = "Não foi possível marcar este Estudo. Tente de novo.";

export function AcoesDoEstudo({ estudoId, anterior, proximo, concluidoInicial }: Props) {
  const [concluido, setConcluido] = useState(concluidoInicial);
  const [mensagem, setMensagem] = useState<Mensagem>(null);
  const [pendente, iniciar] = useTransition();

  function executar(acao: (id: string) => Promise<ResultadoProgresso>, aoConcluir: boolean) {
    iniciar(async () => {
      let resultado: ResultadoProgresso;
      try {
        resultado = await acao(estudoId);
      } catch {
        // A chamada nem chegou ao servidor: sem conexão. Não há fila.
        setMensagem({ tipo: "erro", texto: SEM_CONEXAO });
        return;
      }
      if (!resultado.ok) {
        setMensagem({ tipo: "erro", texto: ERRO_AO_MARCAR });
        return;
      }
      setConcluido(aoConcluir);
      setMensagem(
        aoConcluir
          ? {
              tipo: "sucesso",
              texto: `Estudo concluído. ${resultado.concluidos} de ${resultado.total} em ${resultado.trilha}.`,
            }
          : {
              tipo: "sucesso",
              texto: `Conclusão desmarcada. ${resultado.concluidos} de ${resultado.total} em ${resultado.trilha}.`,
            },
      );
    });
  }

  return (
    <div className="flex flex-col gap-4" data-slot="acoes-do-estudo">
      <div className="flex gap-3">
        {anterior ? (
          <Button variant="secondary" asChild>
            <Link href={`/estudos/${anterior.slug}`}>Anterior</Link>
          </Button>
        ) : (
          // Primeiro Estudo da Trilha: continua no lugar, avisa que não há para onde ir e não faz nada.
          <Button variant="secondary" aria-disabled="true" onClick={(e) => e.preventDefault()}>
            Anterior
          </Button>
        )}
        {concluido ? (
          proximo ? (
            <Button variant="primary" className="flex-1" asChild>
              <Link href={`/estudos/${proximo.slug}`}>Próximo</Link>
            </Button>
          ) : (
            <Button variant="primary" className="flex-1" asChild>
              <Link href="/trilhas">Voltar às Trilhas</Link>
            </Button>
          )
        ) : (
          <Button
            variant="primary"
            className="flex-1"
            pendente={pendente}
            rotuloPendente="Marcando…"
            onClick={() => executar(concluirEstudo, true)}
          >
            Marcar como concluído
          </Button>
        )}
      </div>
      {concluido ? (
        <Button
          variant="ghost"
          className="-ml-4 self-start"
          pendente={pendente}
          rotuloPendente="Desmarcando…"
          onClick={() => executar(desmarcarConclusao, false)}
        >
          Desmarcar conclusão
        </Button>
      ) : null}
      {/* O sucesso é `role="status"` e o erro `role="alert"`: o próprio StatusMessage decide. */}
      {mensagem ? <StatusMessage tipo={mensagem.tipo}>{mensagem.texto}</StatusMessage> : null}
    </div>
  );
}
