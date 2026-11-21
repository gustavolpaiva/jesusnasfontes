"use client";

import { type FormEvent, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { convidarPelaTela } from "@/modules/convites/acoes";
import { type Mensagem, mensagemDaFalha, mensagemDe } from "./mensagens";

// O texto digitado não se perde em erro: o envio chama a ação à mão (`onSubmit`), sem `action`, para
// o React não reiniciar o formulário. Só um convite registrado limpa o campo.
export function FormularioConvite() {
  const [mensagem, setMensagem] = useState<Mensagem | null>(null);
  const [pendente, setPendente] = useState(false);

  async function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const formulario = evento.currentTarget;
    const dados = new FormData(formulario);
    setPendente(true);
    try {
      const resultado = await convidarPelaTela(dados);
      setMensagem(mensagemDe(resultado));
      if (resultado.ok) formulario.reset();
    } catch (erro) {
      const falha = mensagemDaFalha(erro, typeof navigator === "undefined" || navigator.onLine);
      if (falha) setMensagem(falha);
      else throw erro;
    } finally {
      setPendente(false);
    }
  }

  const erro = mensagem?.tipo === "erro";
  return (
    <form onSubmit={aoEnviar} noValidate className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="email-convite">E-mail da pessoa</FieldLabel>
        <Input
          id="email-convite"
          name="email"
          type="email"
          autoComplete="off"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={erro ? true : undefined}
          aria-describedby={mensagem ? "mensagem-convite" : undefined}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        className="w-full md:w-auto md:self-start"
        pendente={pendente}
        rotuloPendente="Convidando…"
      >
        Convidar
      </Button>
      {mensagem ? (
        <div id="mensagem-convite">
          <StatusMessage tipo={mensagem.tipo}>{mensagem.texto}</StatusMessage>
        </div>
      ) : null}
    </form>
  );
}
