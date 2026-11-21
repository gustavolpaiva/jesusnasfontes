"use client";

import {
  type FormEvent,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  aceitarAviso,
  type EstadoConsentimento,
  recusarAviso,
} from "@/modules/privacidade/acoes-consentimento";

const INICIAL: EstadoConsentimento = {};

const ERROS = {
  caixa:
    "Marque a caixa para continuar. Sem o seu consentimento não podemos abrir o site para você.",
  gravacao: "Não conseguimos registrar o seu consentimento. Tente de novo.",
  "sessao-trocada":
    "Este navegador entrou com outra conta. Nada foi registrado. Recarregue a página.",
  "aviso-mudou": "O aviso mudou enquanto você lia. Recarregue a página para ler a versão atual.",
} as const;

// A caixa NÃO desabilita o botão: o botão fica sempre ativo; sem a caixa marcada o envio devolve o
// erro e leva o foco para ela. A caixa nunca vem marcada de antemão e o estado dela é do cliente, para
// um erro de gravação não perder a marcação. "Não concordo, sair" é outro formulário: não grava nada.
export function FormularioConsentimento({
  estudanteId,
  versao,
}: {
  /** Quem abriu a tela e a versão do aviso que ela mostrou: o servidor recusa a divergência. */
  estudanteId: string;
  versao: string;
}) {
  const [estado, acao, pendente] = useActionState(aceitarAviso, INICIAL);
  const [marcada, setMarcada] = useState(false);
  const caixa = useRef<HTMLButtonElement>(null);
  const erro = estado.erro ? ERROS[estado.erro] : null;

  // O envio chama a ação à mão, em vez de `action={...}`: com `action`, o React 19 reinicia o formulário
  // ao fim da ação e a caixa (que o Radix devolve ao valor inicial no `reset`) perderia a marcação.
  function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => acao(dados));
  }

  // Cada resposta com erro de caixa devolve um objeto novo: o foco volta à caixa a cada tentativa.
  useEffect(() => {
    if (estado.erro === "caixa") caixa.current?.focus();
  }, [estado]);

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={aoEnviar} noValidate className="flex flex-col gap-6">
        <input type="hidden" name="estudanteId" value={estudanteId} />
        <input type="hidden" name="versao" value={versao} />
        <div className="flex items-start gap-2 border border-rule-strong p-4">
          <Checkbox
            id="consinto"
            name="consinto"
            ref={caixa}
            checked={marcada}
            onCheckedChange={(v) => setMarcada(v === true)}
            aria-invalid={estado.erro === "caixa" ? true : undefined}
            aria-describedby={erro ? "erro-consentimento" : undefined}
          />
          <label htmlFor="consinto" className="text-leitura pt-2 font-semibold">
            Li o aviso e consinto com o tratamento dos meus dados, inclusive do que possa revelar
            minha crença religiosa, como descrito acima.
          </label>
        </div>
        {erro ? (
          <div id="erro-consentimento">
            <StatusMessage tipo="erro">{erro}</StatusMessage>
          </div>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          pendente={pendente}
          rotuloPendente="Registrando…"
        >
          Concordar e continuar
        </Button>
      </form>
      <form action={recusarAviso}>
        <Button type="submit" variant="ghost" className="w-full">
          Não concordo, sair
        </Button>
      </form>
    </div>
  );
}
