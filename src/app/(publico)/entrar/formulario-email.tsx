"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type EstadoEntrada, pedirEntrada } from "@/modules/identidade/entrada";
import { FormularioCodigo } from "./formulario-codigo";

const INICIAL: EstadoEntrada = { etapa: "email", emailDigitado: "" };

const ERROS = {
  vazio: "Digite o seu e-mail.",
  malformado: "Esse e-mail parece incompleto. Confira e tente de novo.",
  limite: "Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.",
  falha: "Não conseguimos enviar agora. Confira sua conexão e tente de novo.",
} as const;

// Dois passos na mesma rota. "Usar outro e-mail" remonta o formulário do zero.
export function FormularioEntrada() {
  const [rodada, setRodada] = useState(0);
  return <Passos key={rodada} aoTrocarEmail={() => setRodada((n) => n + 1)} />;
}

function Passos({ aoTrocarEmail }: { aoTrocarEmail: () => void }) {
  const [estado, acao, pendente] = useActionState(pedirEntrada, INICIAL);
  const titulo = useRef<HTMLHeadingElement>(null);
  const etapa = estado.etapa;
  // Ao mudar de etapa o foco vai ao título, que anuncia a nova tela.
  useEffect(() => {
    if (etapa === "verifique") titulo.current?.focus();
  }, [etapa]);

  if (estado.etapa === "verifique") {
    return (
      <div className="flex flex-col gap-6">
        <h1 ref={titulo} tabIndex={-1} className="text-display outline-none">
          Verifique seu e-mail
        </h1>
        <p className="text-leitura">
          Se este e-mail foi convidado, enviamos o acesso. Pode levar até um minuto para chegar.
        </p>
        <p className="text-leitura">
          Você digitou{" "}
          <span className="[overflow-wrap:anywhere] hyphens-none">{estado.emailDigitado}</span>. Se
          estiver errado, use outro e-mail.
        </p>
        <p className="text-leitura">Abra o e-mail e toque no link para entrar.</p>
        <p className="text-meta text-ink-muted">
          Não chegou? Olhe a caixa de spam e a de promoções.
        </p>
        <FormularioCodigo email={estado.email} />
        <Button type="button" variant="ghost" onClick={aoTrocarEmail}>
          Usar outro e-mail
        </Button>
      </div>
    );
  }

  const erro = estado.erro ? ERROS[estado.erro] : null;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-display">Entrar</h1>
      <p className="text-leitura">
        Este site é de um grupo fechado. Digite o e-mail para o qual você recebeu o convite e
        enviaremos o acesso.
      </p>
      <form action={acao} noValidate className="flex flex-col gap-6">
        <Field>
          <FieldLabel htmlFor="email">E-mail</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={estado.emailDigitado}
            aria-invalid={erro ? true : undefined}
            aria-describedby={erro ? "erro-email" : undefined}
          />
        </Field>
        {erro ? (
          <div id="erro-email">
            <StatusMessage tipo="erro">{erro}</StatusMessage>
          </div>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          pendente={pendente}
          rotuloPendente="Enviando…"
        >
          Enviar acesso
        </Button>
      </form>
      <p className="text-meta text-ink-muted">
        Ainda não tem convite? Peça a quem organiza o grupo.
      </p>
    </div>
  );
}
