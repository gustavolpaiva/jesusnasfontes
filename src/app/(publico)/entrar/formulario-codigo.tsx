"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  entrarComCodigo,
  type ResultadoCodigo,
  type ResultadoReenvio,
  reenviarAcesso,
} from "@/modules/identidade/entrada";

const ESPERA_SEGUNDOS = 60;

const ERROS_DO_CODIGO = {
  "codigo-invalido": "Código inválido ou vencido. Confira os 6 dígitos ou peça um novo acesso.",
  limite: "Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.",
  falha: "Não conseguimos entrar agora. Confira sua conexão e tente de novo.",
} as const;

const INICIAL_CODIGO: ResultadoCodigo = { codigoDigitado: "" };
const INICIAL_REENVIO: ResultadoReenvio = { rodada: 0 };

// Contagem regressiva do "Enviar de novo". Só o início e o fim são anunciados ao leitor de tela.
function useEspera(reinicio: number) {
  const [restante, setRestante] = useState(ESPERA_SEGUNDOS);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reinicio` recomeça a contagem
  useEffect(() => {
    setRestante(ESPERA_SEGUNDOS);
    const relogio = setInterval(() => setRestante((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(relogio);
  }, [reinicio]);
  return restante;
}

export function FormularioCodigo({ email }: { email: string }) {
  const [estado, acao, pendente] = useActionState(entrarComCodigo, INICIAL_CODIGO);
  const [reenvio, acaoReenvio, reenviando] = useActionState(reenviarAcesso, INICIAL_REENVIO);
  const [codigo, setCodigo] = useState("");
  const restante = useEspera(reenvio.rodada);
  const aberto = restante === ESPERA_SEGUNDOS;
  const anuncio =
    restante === 0
      ? "Você já pode enviar de novo."
      : aberto
        ? "Você pode pedir novo acesso em 60 segundos."
        : "";
  const campo = useRef<HTMLInputElement>(null);
  const erro = estado.resultado ? ERROS_DO_CODIGO[estado.resultado] : null;
  const ultimoCodigo = useRef(estado);
  // O erro leva o foco de volta ao campo, sem apagar o que foi digitado.
  useEffect(() => {
    if (estado !== ultimoCodigo.current && estado.resultado) campo.current?.focus();
    ultimoCodigo.current = estado;
  }, [estado]);

  return (
    <section
      aria-labelledby="titulo-codigo"
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <h2 id="titulo-codigo" className="text-heading">
        Prefere usar o código?
      </h2>
      <p className="text-leitura">
        O mesmo e-mail traz um código de 6 dígitos. Se o link não abrir direito neste aplicativo,
        digite o código aqui.
      </p>
      <form action={acao} className="flex flex-col gap-4">
        <input type="hidden" name="email" value={email} />
        <Field>
          <FieldLabel htmlFor="codigo">Código de 6 dígitos</FieldLabel>
          <InputOTP
            ref={campo}
            id="codigo"
            name="codigo"
            maxLength={6}
            value={codigo}
            onChange={setCodigo}
            pattern="^[0-9]*$"
            aria-invalid={erro ? true : undefined}
            aria-describedby={erro ? "erro-codigo" : undefined}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </Field>
        {erro ? (
          <div id="erro-codigo">
            <StatusMessage tipo="erro">{erro}</StatusMessage>
          </div>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          pendente={pendente}
          rotuloPendente="Entrando…"
        >
          Entrar com o código
        </Button>
      </form>
      <form action={acaoReenvio} className="flex flex-col gap-4">
        <input type="hidden" name="email" value={email} />
        {reenvio.resultado === "reenviado" ? (
          <StatusMessage tipo="sucesso">
            Se este e-mail foi convidado, enviamos o acesso de novo.
          </StatusMessage>
        ) : null}
        {reenvio.resultado === "limite" ? (
          <StatusMessage tipo="erro">{ERROS_DO_CODIGO.limite}</StatusMessage>
        ) : null}
        {reenvio.resultado === "falha" ? (
          <StatusMessage tipo="erro">
            Não conseguimos enviar agora. Confira sua conexão e tente de novo.
          </StatusMessage>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          className="w-full"
          disabled={restante > 0}
          pendente={reenviando}
          rotuloPendente="Enviando…"
        >
          {restante > 0 ? `Enviar de novo em ${restante} s` : "Enviar de novo"}
        </Button>
        <p role="status" className="sr-only">
          {anuncio}
        </p>
      </form>
    </section>
  );
}
