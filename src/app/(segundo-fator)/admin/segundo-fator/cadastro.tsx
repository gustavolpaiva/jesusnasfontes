"use client";

import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import type { ResultadoSegundoFator } from "@/modules/identidade/segundo-fator";
import { mensagemDoResultado } from "./mensagem";

type Props = {
  material: { uri: string; chave: string } | null;
  estado: ResultadoSegundoFator;
  acao: (formData: FormData) => void;
  pendente: boolean;
};

const emGrupos = (chave: string) => chave.match(/.{1,4}/g)?.join(" ") ?? chave;

export function Cadastro({ material, estado, acao, pendente }: Props) {
  const [codigo, setCodigo] = useState("");
  const [copiada, setCopiada] = useState(false);
  const erro = mensagemDoResultado(estado, "aplicativo");

  async function copiar() {
    if (!material) return;
    try {
      await navigator.clipboard.writeText(material.chave);
      setCopiada(true);
    } catch {
      setCopiada(false);
    }
  }

  if (!material) {
    return (
      <div className="coluna-leitura flex flex-col gap-4">
        <h1 className="text-display">Ative o segundo fator</h1>
        <StatusMessage tipo="erro">
          Não conseguimos preparar o cadastro agora. Recarregue a página.
        </StatusMessage>
      </div>
    );
  }

  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Ative o segundo fator</h1>
      <p className="text-leitura">
        Como Admin, você precisa de um segundo fator para entrar. Use um aplicativo autenticador no
        seu celular.
      </p>
      <section aria-labelledby="passo-1" className="flex flex-col gap-4">
        <h2 id="passo-1" className="text-heading">
          1. Escaneie o código no aplicativo
        </h2>
        {/* Ladrilho sempre branco, módulos #1B1D22, nos dois temas (contraste 16,86:1). */}
        <div
          role="img"
          aria-label="Código QR para o aplicativo autenticador"
          data-testid="ladrilho-qr"
          className="size-48 shrink-0 bg-[#FFFFFF]"
        >
          <QRCodeSVG
            value={material.uri}
            size={192}
            level="M"
            marginSize={2}
            bgColor="#FFFFFF"
            fgColor="#1B1D22"
            aria-hidden="true"
          />
        </div>
        <p className="text-leitura">Não consegue escanear? Digite esta chave:</p>
        <p data-testid="chave" className="text-ui font-mono [overflow-wrap:anywhere] tabular-nums">
          {emGrupos(material.chave)}
        </p>
        <Button type="button" variant="secondary" className="self-start" onClick={copiar}>
          Copiar chave
        </Button>
        <p role="status" className="text-label text-ink-muted">
          {copiada ? "Chave copiada." : ""}
        </p>
      </section>
      <form action={acao} className="flex flex-col gap-4">
        <h2 className="text-heading">2. Digite o código de 6 dígitos que o aplicativo mostra</h2>
        <Field>
          <FieldLabel htmlFor="codigo-ativar">Código de 6 dígitos</FieldLabel>
          <InputOTP
            id="codigo-ativar"
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
          pendente={pendente}
          rotuloPendente="Ativando…"
        >
          Ativar
        </Button>
      </form>
    </div>
  );
}
