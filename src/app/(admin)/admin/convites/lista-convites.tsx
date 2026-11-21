"use client";

import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { reenviarConvite, revogarConvite } from "@/modules/convites/acoes";
import type { ConviteListado } from "@/modules/convites/consultas";
import { type Mensagem, mensagemDaFalha, mensagemDe } from "./mensagens";
import { RevogarDialogo } from "./revogar-dialogo";

type Props = {
  // null: a carga falhou (a página só chega aqui depois de provar que é Admin).
  convites: ConviteListado[] | null;
};

const ROTULO = { pendente: "Pendente", aceito: "Aceito", revogado: "Revogado" } as const;

function Chip({ estado }: { estado: ConviteListado["estado"] }) {
  // Sem depender de cor: Pendente tem borda tracejada, Aceito borda sólida em tinta, Revogado borda
  // sólida mais clara e texto apagado (o e-mail riscado fica na linha).
  if (estado === "pendente") return <Badge variant="preparacao">{ROTULO.pendente}</Badge>;
  if (estado === "aceito") return <Badge>{ROTULO.aceito}</Badge>;
  return <Badge className="border-rule-strong text-ink-muted">{ROTULO.revogado}</Badge>;
}

// "19/11/2026", no fuso do Brasil: curta de propósito, para a linha de computador caber em 704 px.
const FORMATO_DE_DATA = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "America/Sao_Paulo",
});

function dataDoEstado(c: ConviteListado): string {
  if (c.estado === "aceito" && c.aceitoEm) return `aceito em ${FORMATO_DE_DATA.format(c.aceitoEm)}`;
  if (c.estado === "revogado" && c.revogadoEm) {
    return `revogado em ${FORMATO_DE_DATA.format(c.revogadoEm)}`;
  }
  return `convidado em ${FORMATO_DE_DATA.format(c.criadoEm)}`;
}

export function ListaConvites({ convites }: Props) {
  const [mensagem, setMensagem] = useState<Mensagem | null>(null);
  const [reenviando, setReenviando] = useState<string | null>(null);
  const aviso = useRef<HTMLDivElement>(null);

  // Revogar apaga os botões da linha: sem isto o foco se perderia. O resultado de qualquer ação
  // recebe o foco (é anunciado e o teclado continua dali).
  useEffect(() => {
    if (mensagem) aviso.current?.focus();
  }, [mensagem]);

  async function executar(acao: () => ReturnType<typeof reenviarConvite>) {
    try {
      setMensagem(mensagemDe(await acao()));
    } catch (erro) {
      const falha = mensagemDaFalha(erro, typeof navigator === "undefined" || navigator.onLine);
      if (falha) setMensagem(falha);
      else throw erro;
    }
  }

  async function reenviar(id: string) {
    setReenviando(id);
    try {
      await executar(() => reenviarConvite(id));
    } finally {
      setReenviando(null);
    }
  }

  if (convites === null) {
    return (
      <section aria-labelledby="titulo-convidados" className="flex flex-col gap-4">
        <h2 id="titulo-convidados" className="text-label text-ink-muted">
          Convidados
        </h2>
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <a href="/admin/convites">Tentar de novo</a>
            </Button>
          }
        >
          Não conseguimos carregar os convites. Tente de novo.
        </StatusMessage>
      </section>
    );
  }

  return (
    <section aria-labelledby="titulo-convidados" className="flex flex-col gap-4">
      <h2 id="titulo-convidados" className="text-label text-ink-muted">
        Convidados ({convites.length})
      </h2>
      {mensagem ? (
        <div ref={aviso} tabIndex={-1} className="outline-none">
          <StatusMessage tipo={mensagem.tipo}>{mensagem.texto}</StatusMessage>
        </div>
      ) : null}
      {convites.length === 0 ? (
        <EmptyState
          titulo="Nenhum convite ainda"
          descricao="Convide a primeira pessoa pelo campo acima."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {convites.map((c) => (
            <li
              key={c.id}
              data-estado={c.estado}
              className="flex flex-col gap-2 py-4 md:grid md:grid-cols-[minmax(0,1fr)_10rem_13rem] md:items-center md:gap-4"
            >
              {/* O estilo em linha vence o `hyphens: auto` do papel de leitura: endereço não se hifeniza. */}
              <p
                style={{ hyphens: "none" }}
                className={`text-leitura min-w-0 [overflow-wrap:anywhere] ${
                  c.estado === "revogado" ? "text-ink-muted line-through" : ""
                }`}
              >
                {c.email}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:flex-col md:items-start">
                <Chip estado={c.estado} />
                <span className="text-meta text-ink-muted">{dataDoEstado(c)}</span>
                {c.proprio ? <span className="text-meta text-ink-muted">Seu convite</span> : null}
              </div>
              {c.estado !== "revogado" && !c.proprio ? (
                <div className="flex flex-wrap gap-2 md:col-start-3 md:justify-end">
                  {c.estado === "pendente" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={`Reenviar convite para ${c.email}`}
                      pendente={reenviando === c.id}
                      rotuloPendente="Reenviando…"
                      disabled={reenviando !== null && reenviando !== c.id}
                      onClick={() => reenviar(c.id)}
                    >
                      Reenviar
                    </Button>
                  ) : null}
                  <RevogarDialogo
                    email={c.email}
                    estado={c.estado}
                    aoConfirmar={() => executar(() => revogarConvite(c.id))}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
