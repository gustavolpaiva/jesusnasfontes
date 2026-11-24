"use client";

import { Check } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { item, livre, marcado } from "@/components/acervo/filtro-nivel";
import { NOME_DO_NIVEL } from "@/modules/acervo/niveis";
import type { Nivel } from "@/modules/acervo/schemas";

// Filtro por Nível de fonte na forma de RADIO (a da busca, `/acervo/busca`): `role="radiogroup"` com legenda
// "Nível de fonte" e "Todos os Níveis" mais um item por Nível que tem Fonte (D-13). O desenho é o mesmo da forma
// de links (`filtro-nivel.tsx`): 44 px, contorno, preenchimento invertido e `check` ao marcar; a seleção nunca
// depende só de cor. O valor fica no estado do formulário: a busca é um POST e nada vai para a URL.

export const TODOS_OS_NIVEIS = "todos" as const;
export type EscolhaDeNivel = Nivel | typeof TODOS_OS_NIVEIS;

type Props = {
  oferecidos: readonly { nivel: Nivel; total: number }[];
  valor: EscolhaDeNivel;
  onChange: (valor: EscolhaDeNivel) => void;
  disabled?: boolean;
};

function Opcao({
  valor,
  rotulo,
  contagem,
  ativo,
}: {
  valor: EscolhaDeNivel;
  rotulo: string;
  contagem?: number;
  ativo: boolean;
}) {
  return (
    <RadioGroupPrimitive.Item
      value={valor}
      data-slot="filtro-nivel-item"
      className={`${item} cursor-pointer ${ativo ? marcado : livre}`}
    >
      {ativo ? <Check aria-hidden="true" strokeWidth={2} className="size-3 shrink-0" /> : null}
      <span>
        {rotulo}
        {contagem === undefined ? null : <span className="text-meta"> ({contagem})</span>}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

export function FiltroNivelRadio({ oferecidos, valor, onChange, disabled }: Props) {
  return (
    <div className="flex flex-col gap-2" data-slot="filtro-nivel">
      <span id="filtro-nivel-legenda" className="text-label">
        Nível de fonte
      </span>
      <RadioGroupPrimitive.Root
        aria-labelledby="filtro-nivel-legenda"
        value={valor}
        onValueChange={(v) => onChange(v as EscolhaDeNivel)}
        disabled={disabled}
        orientation="horizontal"
        className="flex flex-wrap gap-2"
      >
        <Opcao valor={TODOS_OS_NIVEIS} rotulo="Todos os Níveis" ativo={valor === TODOS_OS_NIVEIS} />
        {oferecidos.map((o) => (
          <Opcao
            key={o.nivel}
            valor={o.nivel}
            rotulo={NOME_DO_NIVEL[o.nivel]}
            contagem={o.total}
            ativo={valor === o.nivel}
          />
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}
