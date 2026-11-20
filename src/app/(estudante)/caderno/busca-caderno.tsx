"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buscarCaderno } from "@/modules/caderno/acoes-caderno";
import type { EntradaDoCaderno, PaginaDoCaderno } from "@/modules/caderno/caderno";
import { TERMO_MAX } from "@/modules/caderno/limite";
import { EntradaCaderno } from "./entrada-caderno";

// Busca e lista do Caderno (tela 10). A busca é um formulário que chega ao servidor por POST (a Server
// Action `buscarCaderno`): o termo viaja no corpo da requisição e NUNCA na URL, porque a URL aparece nos
// registros da hospedagem (PRIV-04). Por isso o resultado de uma busca não tem endereço próprio, e a tela
// oferece "Limpar busca". `method="post"` no formulário é o cinto: se o navegador o enviar antes de a página
// hidratar, o termo ainda não vai para a URL (o envio normal é feito aqui, sem recarregar).
//
// O resultado anterior fica na tela enquanto a nova busca roda. O texto das Anotações é privado: aqui só
// chega à tela.

type Visao = { termo: string; entradas: EntradaDoCaderno[]; total: number; proximo: string | null };
type Aviso = "falha" | "offline" | null;

const SEM_CONEXAO = "Sem conexão. A busca precisa de internet.";
const FALHA = "Não conseguimos buscar agora. Tente de novo.";

function contagem(termo: string, total: number): string {
  if (total === 0) return `Nenhuma Anotação com "${termo}"`;
  if (total === 1) return `1 Anotação com "${termo}"`;
  return `${total} Anotações com "${termo}"`;
}

type Props = {
  /** A primeira página, lida no servidor; `null` se a leitura falhou. */
  inicial: PaginaDoCaderno | null;
};

export function BuscaCaderno({ inicial }: Props) {
  const roteador = useRouter();
  const visaoInicial = useRef<Visao | null>(inicial ? { termo: "", ...inicial } : null);
  const [visao, setVisao] = useState<Visao | null>(visaoInicial.current);
  const [campo, setCampo] = useState("");
  const [aviso, setAviso] = useState<Aviso>(inicial ? null : "falha");
  const [buscando, iniciarBusca] = useTransition();
  const [carregandoMais, iniciarMais] = useTransition();

  const semConexao = () => typeof navigator !== "undefined" && !navigator.onLine;

  async function chamar(termo: string, cursor: string | null) {
    const dados = new FormData();
    dados.set("termo", termo);
    if (cursor) dados.set("cursor", cursor);
    try {
      return await buscarCaderno(dados);
    } catch {
      // A chamada nem chegou ao servidor.
      return null;
    }
  }

  function buscar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const termo = campo.trim();
    if (semConexao()) {
      setAviso("offline");
      return;
    }
    iniciarBusca(async () => {
      const r = await chamar(termo, null);
      if (!r) {
        setAviso(semConexao() ? "offline" : "falha");
        return;
      }
      if (!r.ok) {
        setAviso("falha");
        return;
      }
      setAviso(null);
      setVisao({ termo: r.termo, entradas: r.entradas, total: r.total, proximo: r.proximo });
    });
  }

  function limpar() {
    setCampo("");
    setAviso(visaoInicial.current ? null : "falha");
    setVisao(visaoInicial.current);
  }

  function mostrarMais() {
    if (!visao?.proximo) return;
    if (semConexao()) {
      setAviso("offline");
      return;
    }
    const { termo, proximo } = visao;
    iniciarMais(async () => {
      const r = await chamar(termo, proximo);
      if (!r?.ok) {
        setAviso(r === null && semConexao() ? "offline" : "falha");
        return;
      }
      setAviso(null);
      setVisao((atual) => {
        // A busca mudou enquanto esta página vinha: não mistura resultados de termos diferentes.
        if (!atual || atual.termo !== termo) return atual;
        const jaTem = new Set(atual.entradas.map((e) => e.chave));
        return {
          termo,
          entradas: [...atual.entradas, ...r.entradas.filter((e) => !jaTem.has(e.chave))],
          total: r.total,
          proximo: r.proximo,
        };
      });
    });
  }

  const restante = visao ? Math.max(0, visao.total - visao.entradas.length) : 0;
  const buscaAtiva = visao !== null && visao.termo !== "";

  return (
    <div className="flex flex-col gap-6">
      <search>
        <form method="post" onSubmit={buscar} className="flex flex-col gap-2">
          <label htmlFor="caderno-termo" className="text-label">
            Buscar nas Anotações
          </label>
          <div className="flex gap-3">
            <Input
              id="caderno-termo"
              type="search"
              name="termo"
              value={campo}
              onChange={(e) => setCampo(e.target.value)}
              maxLength={TERMO_MAX}
              autoComplete="off"
              enterKeyHint="search"
              aria-describedby="caderno-ajuda"
              className="flex-1"
            />
            <Button type="submit" variant="secondary" aria-busy={buscando} disabled={buscando}>
              {buscando ? "Buscando…" : "Buscar"}
            </Button>
          </div>
          <p id="caderno-ajuda" className="text-meta text-ink-muted">
            Procure por uma palavra. A busca ignora acentos e maiúsculas.
          </p>
        </form>
      </search>

      {aviso === "offline" ? <StatusMessage tipo="aviso">{SEM_CONEXAO}</StatusMessage> : null}
      {aviso === "falha" ? (
        <StatusMessage
          tipo="erro"
          acao={
            visao === null ? (
              <Button variant="secondary" onClick={() => roteador.refresh()}>
                Tentar de novo
              </Button>
            ) : undefined
          }
        >
          {FALHA}
        </StatusMessage>
      ) : null}

      {buscaAtiva ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p role="status" aria-live="polite" className="text-ui [overflow-wrap:anywhere]">
            {contagem(visao.termo, visao.total)}
          </p>
          <Button variant="secondary" onClick={limpar}>
            Limpar busca
          </Button>
        </div>
      ) : null}

      {visao && visao.entradas.length > 0 ? (
        <>
          <ul
            aria-label={buscaAtiva ? "Resultado da busca" : "Anotações"}
            className="flex flex-col"
          >
            {visao.entradas.map((e) => (
              <EntradaCaderno key={e.chave} entrada={e} />
            ))}
          </ul>
          {visao.proximo ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                variant="secondary"
                onClick={mostrarMais}
                disabled={carregandoMais}
                aria-busy={carregandoMais}
              >
                {carregandoMais ? "Buscando…" : "Mostrar mais Anotações"}
              </Button>
              <p className="text-meta text-ink-muted">
                {restante === 1 ? "Resta 1 entrada." : `Restam ${restante} entradas.`}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {visao && visao.entradas.length === 0 ? (
        buscaAtiva ? (
          <EmptyState
            titulo="Nenhuma Anotação encontrada"
            descricao="Tente outra palavra ou uma parte dela. A busca ignora acentos e maiúsculas."
          />
        ) : (
          <EmptyState
            titulo="Seu Caderno está vazio"
            descricao="Quando você escrever uma Anotação em um Estudo, ela aparece aqui."
            acao={
              <Button variant="primary" asChild>
                <Link href="/trilhas">Ir para as Trilhas</Link>
              </Button>
            }
          />
        )
      ) : null}
    </div>
  );
}
