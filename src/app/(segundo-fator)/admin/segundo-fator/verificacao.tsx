"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  type ResultadoSegundoFator,
  usarCodigoDeRecuperacao,
  verificarSegundoFator,
} from "@/modules/identidade/segundo-fator";
import { mensagemDoResultado } from "./mensagem";

const INICIAL: ResultadoSegundoFator = {};

export function Verificacao() {
  const [recuperacao, setRecuperacao] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [estadoApp, acaoApp, pendenteApp] = useActionState(verificarSegundoFator, INICIAL);
  const [estadoRec, acaoRec, pendenteRec] = useActionState(usarCodigoDeRecuperacao, INICIAL);
  const erro = mensagemDoResultado(
    recuperacao ? estadoRec : estadoApp,
    recuperacao ? "recuperacao" : "aplicativo",
  );

  const campo = useRef<HTMLInputElement>(null);
  const ultimoApp = useRef(estadoApp);
  // Depois de uma resposta com erro, o campo é esvaziado e recebe o foco.
  useEffect(() => {
    if (estadoApp !== ultimoApp.current && estadoApp.resultado) {
      setCodigo("");
      campo.current?.focus();
    }
    ultimoApp.current = estadoApp;
  }, [estadoApp]);

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Segundo fator</h1>
      <p className="text-leitura">
        {recuperacao
          ? "Digite um dos seus códigos de recuperação. Cada código vale uma vez."
          : "Digite o código de 6 dígitos do seu aplicativo autenticador."}
      </p>
      {recuperacao ? (
        <form action={acaoRec} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="codigo-recuperacao">Código de recuperação</FieldLabel>
            <Input
              id="codigo-recuperacao"
              name="codigo"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={erro ? true : undefined}
            />
          </Field>
          {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            pendente={pendenteRec}
            rotuloPendente="Confirmando…"
          >
            Confirmar
          </Button>
        </form>
      ) : (
        <form action={acaoApp} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="codigo-verificar">Código de 6 dígitos</FieldLabel>
            <InputOTP
              ref={campo}
              id="codigo-verificar"
              name="codigo"
              maxLength={6}
              value={codigo}
              onChange={setCodigo}
              pattern="^[0-9]*$"
              aria-invalid={erro ? true : undefined}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </Field>
          {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            pendente={pendenteApp}
            rotuloPendente="Confirmando…"
          >
            Confirmar
          </Button>
        </form>
      )}
      <Button
        type="button"
        variant="ghost"
        className="self-start"
        onClick={() => setRecuperacao((v) => !v)}
      >
        {recuperacao ? "Usar o código do aplicativo" : "Usar um código de recuperação"}
      </Button>
      <p className="text-label text-ink-muted">
        Perdeu o aparelho e os códigos? A recuperação é feita pelo responsável técnico pelo banco.
      </p>
    </div>
  );
}
