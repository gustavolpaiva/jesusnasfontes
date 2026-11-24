"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useId, useState } from "react";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { paginaVisivel } from "@/components/acervo/item-de-ficha";
import {
  FRASE_DO_GRAU,
  PontosDoGrau,
  ROTULO_DO_GRAU,
  SeloGrau,
} from "@/components/acervo/selo-grau";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { StatusMessage } from "@/components/estado/status-message";
import { Algarismos } from "@/components/ui/algarismos";
import { Button } from "@/components/ui/button";
import type { CitacaoProposta, PropostaDoPainel } from "@/modules/acervo/consultas-graus";
import {
  GRAUS,
  type GrauDeCerteza,
  motivoDoBotao,
  rotuloDoBotao,
} from "@/modules/acervo/estado-da-proposta";
import { MENSAGENS_GRAUS, type RecusaDaAprovacao } from "@/modules/acervo/painel-graus";
import { enderecoDoSegundoFator } from "@/modules/identidade/retorno-segundo-fator";

// O conteúdo aberto de uma proposta de Grau (ACER-06, ACER-10, D-04; UI-SPEC tela 13): a frase inteira, o Grau proposto
// e a justificativa, as Citações propostas (cada uma com o seu Nível, a Fonte ou a ficha e o trecho), o grupo de escolha
// do Grau (já no valor proposto: trocar o valor É a correção) e a ação "Aprovar este grau", sem diálogo e sem rejeitar.
// O botão é SEMPRE focável: sem efeito (`aria-disabled`), o motivo vem em TEXTO ao lado. O que o dono vê aqui são os dois
// hashes que o servidor leu junto da lista; a ação os devolve e o banco os confere.

const LISTA_DE_GRAUS = "/admin/acervo/graus";

type Props = {
  proposta: PropostaDoPainel;
  /** Há uma escrita no ar em QUALQUER proposta da lista: nenhum botão tem efeito até ela voltar. */
  ocupado: boolean;
  /** A escrita no ar é desta proposta (o botão diz "Aprovando…"). */
  salvando: boolean;
  recusa: RecusaDaAprovacao | null;
  aoAprovar: (grau: GrauDeCerteza) => void;
  aoRecarregar: () => void;
};

function Rotulo({ children, id }: { children: string; id?: string }) {
  return (
    <h4 id={id} className="text-label text-ink-muted">
      <Algarismos>{children}</Algarismos>
    </h4>
  );
}

function ItemDaCitacao({ c }: { c: CitacaoProposta }) {
  const rotulo =
    c.tipo === "paragrafo" ? (
      <>
        {c.autor ? `${c.autor}, ` : ""}
        <em>{c.obra}</em>, {c.ref}
      </>
    ) : c.tipo === "ficha" ? (
      `Trecho da ficha${paginaVisivel(c.pagina) ? `, ${paginaVisivel(c.pagina)}` : ""} de ${c.obra}`
    ) : (
      c.referencia
    );
  const trecho =
    c.tipo === "passagem"
      ? c.versiculos && c.versiculos.length > 0
        ? c.versiculos.map((v) => v.texto).join(" ")
        : null
      : c.trecho;
  const idioma = c.tipo === "passagem" ? "pt" : c.idioma;
  return (
    <li data-slot="citacao-proposta" data-alvo={c.tipo} className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <SeloNivel nivel={c.nivel} className="whitespace-normal" />
        {c.tipo === "ficha" && !c.verificada ? (
          <ChipEstado tom="pendente">A conferir</ChipEstado>
        ) : null}
      </span>
      <span className="text-ui block font-semibold [overflow-wrap:anywhere]">{rotulo}</span>
      {trecho ? (
        <q
          lang={idioma === "en" ? "en" : "pt-BR"}
          data-slot="trecho-citado"
          className="text-leitura block border-l-2 border-ink pl-4 [overflow-wrap:anywhere]"
        >
          {trecho}
        </q>
      ) : null}
    </li>
  );
}

export function PropostaGrau({
  proposta: p,
  ocupado,
  salvando,
  recusa,
  aoAprovar,
  aoRecarregar,
}: Props) {
  const id = useId();
  const [escolhido, setEscolhido] = useState<GrauDeCerteza>(p.grauAprovado ?? p.grauProposto);
  const motivo = motivoDoBotao({
    estado: p.estado,
    fichasFaltando: p.fichasFaltando,
    fontesFaltando: p.fontesFaltando,
  });
  const semEfeito = motivo !== null || ocupado;
  const idMotivo = `${id}-motivo`;
  const idLegenda = `${id}-legenda`;
  const idFrase = `${id}-frase`;

  function acionar() {
    if (semEfeito) return;
    aoAprovar(escolhido);
  }

  return (
    <div className="flex flex-col gap-6 pt-2" data-slot="proposta-grau" data-estado={p.estado}>
      <section className="flex flex-col gap-2" aria-label="Frase">
        <p className="text-leitura [overflow-wrap:anywhere]" data-slot="frase-inteira">
          {p.frase}
        </p>
        <Link
          href={`/estudos/${p.estudoSlug}`}
          className="text-ui inline-flex min-h-11 w-fit items-center rounded-sm underline underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {MENSAGENS_GRAUS.verNoEstudo}
        </Link>
      </section>

      <section className="flex flex-col gap-2">
        <Rotulo>Grau proposto</Rotulo>
        <SeloGrau grau={p.grauProposto} />
        <Rotulo>Justificativa</Rotulo>
        <p className="text-ui [overflow-wrap:anywhere]" data-slot="justificativa">
          {p.justificativa}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Rotulo>Citações propostas</Rotulo>
        <ul className="flex flex-col gap-4" data-slot="citacoes-propostas">
          {p.citacoes.map((c) => (
            <ItemDaCitacao key={c.id} c={c} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h4 id={idLegenda} className="text-label text-ink-muted">
          Grau de certeza
        </h4>
        <RadioGroupPrimitive.Root
          aria-labelledby={idLegenda}
          aria-describedby={idFrase}
          value={escolhido}
          onValueChange={(v) => setEscolhido(v as GrauDeCerteza)}
          disabled={salvando}
          orientation="vertical"
          data-slot="escolha-do-grau"
          className="flex flex-wrap gap-2"
        >
          {GRAUS.map((g) => {
            const ativo = escolhido === g;
            return (
              <RadioGroupPrimitive.Item
                key={g}
                value={g}
                data-slot="grau-opcao"
                data-grau={g}
                className={`text-label inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-sm bg-paper-soft px-3 py-1 whitespace-nowrap text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                  ativo ? "border-2 border-ink" : "border border-rule-strong"
                }`}
              >
                {ativo ? (
                  <Check aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
                ) : null}
                <PontosDoGrau grau={g} />
                <span>{ROTULO_DO_GRAU[g]}</span>
              </RadioGroupPrimitive.Item>
            );
          })}
        </RadioGroupPrimitive.Root>
        <p id={idFrase} className="text-meta text-ink-muted" data-slot="frase-do-grau">
          {FRASE_DO_GRAU[escolhido]}
        </p>
      </section>

      {recusa ? (
        <div data-slot="recusa-do-grau" data-motivo={recusa.motivo}>
          {recusa.motivo === "segundo-fator" ? (
            <StatusMessage
              tipo="erro"
              acao={
                <Button asChild variant="secondary">
                  <a href={enderecoDoSegundoFator("/admin/segundo-fator", LISTA_DE_GRAUS)}>
                    {MENSAGENS_GRAUS.confirmarSegundoFator}
                  </a>
                </Button>
              }
            >
              {recusa.mensagem}
            </StatusMessage>
          ) : recusa.motivo === "servidor" || recusa.motivo === "invalido" ? (
            <StatusMessage tipo="erro">{recusa.mensagem}</StatusMessage>
          ) : (
            <StatusMessage
              tipo="erro"
              acao={
                <Button type="button" variant="secondary" onClick={aoRecarregar}>
                  {MENSAGENS_GRAUS.recarregar}
                </Button>
              }
            >
              {recusa.mensagem}
            </StatusMessage>
          )}
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="primary"
          data-slot="aprovar-grau"
          aria-disabled={semEfeito || undefined}
          aria-describedby={motivo ? idMotivo : undefined}
          onClick={acionar}
        >
          {salvando ? MENSAGENS_GRAUS.aprovando : rotuloDoBotao(escolhido, p.grauProposto)}
        </Button>
        {motivo ? (
          <p id={idMotivo} className="text-meta text-ink-muted" data-slot="motivo-do-grau">
            {motivo}
          </p>
        ) : null}
      </div>
    </div>
  );
}
