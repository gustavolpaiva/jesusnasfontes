"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { formatarData, formatarHora } from "@/modules/sessao/formato";

// Conflito da Anotação (tela 9): a Anotação do servidor mudou em outro aparelho e este aparelho tem um
// texto diferente ainda não enviado. NUNCA "o último vence" calado: as duas versões aparecem INTEIRAS,
// lado a lado em tela larga e empilhadas em 390 px, ambas selecionáveis e copiáveis (são texto comum,
// sem `user-select: none` e sem campo desabilitado), e a pessoa escolhe qual manter. Não há botão que
// junte as duas. O texto é privado: aqui só chega à tela, nunca a registro nem a URL.

export type VersaoDoConflito = { corpo: string; em: Date | null };

type Props = {
  conta: VersaoDoConflito;
  rascunho: VersaoDoConflito;
  aoManterConta: () => void;
  aoUsarRascunho: () => void;
};

const data = (d: Date | null) => (d ? `${formatarData(d)}, ${formatarHora(d)}` : null);

function Caixa({
  rotulo,
  versao,
  vazia,
}: {
  rotulo: string;
  versao: VersaoDoConflito;
  vazia: string;
}) {
  const quando = data(versao.em);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 border border-rule-strong p-3">
      <p className="text-label text-ink-muted">{rotulo}</p>
      {quando ? <p className="text-meta text-ink-muted">{quando}</p> : null}
      {versao.corpo === "" ? (
        <p className="text-meta text-ink-muted">{vazia}</p>
      ) : (
        <p className="text-leitura whitespace-pre-wrap [overflow-wrap:anywhere]">{versao.corpo}</p>
      )}
    </div>
  );
}

export function ConflictPanel({ conta, rascunho, aoManterConta, aoUsarRascunho }: Props) {
  const titulo = useRef<HTMLHeadingElement>(null);
  // O painel aparece no meio da escrita: o foco vai para o título, que o leitor de tela anuncia.
  useEffect(() => {
    titulo.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby="conflito-titulo"
      data-slot="conflict-panel"
      className="flex flex-col gap-4 border-l-4 border-l-signal-warning border border-rule-strong p-4"
    >
      <h3 id="conflito-titulo" ref={titulo} tabIndex={-1} className="text-heading outline-none">
        Esta Anotação mudou em outro aparelho
      </h3>
      <p className="text-leitura">
        Escolha qual versão manter. A outra será descartada, então copie o que quiser guardar antes.
      </p>
      <div className="flex flex-col gap-3 md:flex-row">
        <Caixa rotulo="Versão salva na sua conta" versao={conta} vazia="(Anotação apagada)" />
        <Caixa rotulo="Rascunho deste aparelho" versao={rascunho} vazia="(vazio)" />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="secondary" onClick={aoManterConta}>
          Manter a da conta
        </Button>
        <Button variant="primary" onClick={aoUsarRascunho}>
          Usar o rascunho
        </Button>
      </div>
    </section>
  );
}
