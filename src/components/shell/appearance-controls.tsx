"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { definirPasso, definirTema } from "@/modules/aparencia/acoes";
import {
  ESCALAS,
  NOMES_DOS_PASSOS,
  PASSO_PADRAO,
  type Passo,
} from "@/modules/aparencia/preferencias";

type EscolhaDeTema = "aparelho" | "claro" | "escuro";

// O conteúdo do Menu só existe no cliente (a folha monta ao abrir), então o estado inicial é
// lido do <html>, que o servidor já escreveu a partir dos cookies.
function temaAtual(): EscolhaDeTema {
  const valor = document.documentElement.getAttribute("data-tema");
  return valor === "claro" || valor === "escuro" ? valor : "aparelho";
}

function passoAtual(): Passo {
  const bruto = Number.parseFloat(
    document.documentElement.style.getPropertyValue("--escala-texto"),
  );
  const indice = ESCALAS.findIndex((escala) => Math.abs(escala - bruto) < 0.001);
  return (indice >= 0 ? indice + 1 : PASSO_PADRAO) as Passo;
}

export function AppearanceControls() {
  const [tema, setTema] = useState<EscolhaDeTema>(temaAtual);
  const [passo, setPasso] = useState<Passo>(passoAtual);
  const [anuncio, setAnuncio] = useState("");
  const [, iniciar] = useTransition();

  function escolherTema(valor: EscolhaDeTema) {
    setTema(valor);
    // Vale na hora, sem recarregar; o cookie guarda para a próxima visita.
    if (valor === "aparelho") document.documentElement.removeAttribute("data-tema");
    else document.documentElement.setAttribute("data-tema", valor);
    iniciar(async () => {
      await definirTema(valor).catch(() => undefined);
    });
  }

  function escolherPasso(novo: Passo) {
    setPasso(novo);
    document.documentElement.style.setProperty("--escala-texto", String(ESCALAS[novo - 1]));
    setAnuncio(`Tamanho do texto: ${NOMES_DOS_PASSOS[novo - 1]}, ${novo} de 5`);
    iniciar(async () => {
      await definirPasso(novo).catch(() => undefined);
    });
  }

  const noMinimo = passo === 1;
  const noMaximo = passo === 5;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 id="rotulo-tema" className="text-label text-ink-muted">
          Tema
        </h3>
        <RadioGroup
          aria-labelledby="rotulo-tema"
          value={tema}
          onValueChange={(valor) => escolherTema(valor as EscolhaDeTema)}
        >
          {(
            [
              ["aparelho", "Do aparelho"],
              ["claro", "Claro"],
              ["escuro", "Escuro"],
            ] as const
          ).map(([valor, rotulo]) => (
            <div key={valor} className="flex min-h-11 items-center gap-2">
              <RadioGroupItem value={valor} id={`tema-${valor}`} />
              <label
                htmlFor={`tema-${valor}`}
                className="text-ui flex min-h-11 flex-1 items-center"
              >
                {rotulo}
              </label>
            </div>
          ))}
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-2">
        <h3 id="rotulo-tamanho" className="text-label text-ink-muted">
          Tamanho do texto
        </h3>
        <fieldset
          aria-labelledby="rotulo-tamanho"
          className="m-0 flex min-w-0 items-center gap-3 border-0 p-0"
        >
          <Button
            variant="secondary"
            size="icon"
            aria-label="A− Diminuir texto"
            aria-disabled={noMinimo}
            onClick={() => {
              if (!noMinimo) escolherPasso((passo - 1) as Passo);
            }}
          >
            <span aria-hidden="true" className="text-ui">
              A−
            </span>
          </Button>
          <div className="flex min-w-0 flex-1 flex-col items-center text-center">
            <span className="text-ui font-semibold">{NOMES_DOS_PASSOS[passo - 1]}</span>
            <span className="text-meta text-ink-muted">{passo} de 5</span>
          </div>
          <Button
            variant="secondary"
            size="icon"
            aria-label="A+ Aumentar texto"
            aria-disabled={noMaximo}
            onClick={() => {
              if (!noMaximo) escolherPasso((passo + 1) as Passo);
            }}
          >
            <span aria-hidden="true" className="text-ui">
              A+
            </span>
          </Button>
        </fieldset>
        <p className="text-leitura border-y border-border py-3" data-testid="amostra-de-texto">
          Assim fica o texto de leitura.
        </p>
        <Button
          variant="ghost"
          className="-ml-4 self-start"
          aria-disabled={passo === PASSO_PADRAO}
          onClick={() => {
            if (passo !== PASSO_PADRAO) escolherPasso(PASSO_PADRAO);
          }}
        >
          Voltar ao padrão
        </Button>
        <p aria-live="polite" className="sr-only">
          {anuncio}
        </p>
      </div>
    </div>
  );
}
