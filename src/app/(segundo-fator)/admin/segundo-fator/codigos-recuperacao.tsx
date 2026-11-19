"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export function CodigosRecuperacao({ codigos }: { codigos: string[] }) {
  const roteador = useRouter();
  const caixa = useRef<HTMLButtonElement>(null);
  const [guardei, setGuardei] = useState(false);
  const [erro, setErro] = useState(false);
  const [copiados, setCopiados] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(codigos.join("\n"));
      setCopiados(true);
    } catch {
      setCopiados(false);
    }
  }

  function concluir(evento: React.FormEvent) {
    evento.preventDefault();
    if (!guardei) {
      setErro(true);
      caixa.current?.focus();
      return;
    }
    roteador.push("/admin");
  }

  return (
    <form onSubmit={concluir} className="coluna-leitura flex flex-col gap-6" noValidate>
      <h1 className="text-display">Guarde seus códigos de recuperação</h1>
      <p className="text-leitura">
        Cada código vale uma vez e só aparece agora. Guarde-os num lugar seguro, fora deste
        aparelho.
      </p>
      <ol
        data-testid="codigos"
        className="text-ui flex list-decimal flex-col gap-2 pl-8 font-mono tabular-nums"
      >
        {codigos.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <Button type="button" variant="secondary" className="self-start" onClick={copiar}>
        Copiar códigos
      </Button>
      <p role="status" className="text-label text-ink-muted">
        {copiados ? "Códigos copiados." : ""}
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          id="guardei"
          ref={caixa}
          checked={guardei}
          onCheckedChange={(v) => {
            setGuardei(v === true);
            if (v === true) setErro(false);
          }}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? "erro-guardei" : undefined}
        />
        <label htmlFor="guardei" className="text-leitura pt-2">
          Guardei os códigos em um lugar seguro.
        </label>
      </div>
      {erro ? (
        <div id="erro-guardei">
          <StatusMessage tipo="erro">Marque a caixa depois de guardar os códigos.</StatusMessage>
        </div>
      ) : null}
      <Button type="submit" variant="primary" className="w-full">
        Concluir
      </Button>
    </form>
  );
}
