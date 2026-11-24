"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type EscolhaDeNivel,
  FiltroNivelRadio,
  TODOS_OS_NIVEIS,
} from "@/components/acervo/filtro-nivel-radio";
import { ResultadoBusca } from "@/components/acervo/resultado-busca";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buscarAcervo } from "@/modules/acervo/acoes-busca";
import type { ResultadoDeBusca } from "@/modules/acervo/busca";
import { CHAVE_DO_TERMO_PENDENTE, TERMO_DA_BUSCA_MAX } from "@/modules/acervo/busca-limites";
import type { Nivel } from "@/modules/acervo/schemas";

// Busca do Acervo (tela 3). A busca é um formulário que chega ao servidor por POST (a Server Action
// `buscarAcervo`): o termo viaja no corpo da requisição e NUNCA na URL, porque a URL aparece nos registros da
// hospedagem (PRIV-04) e o que alguém procura sobre a fé pode revelar crença. Por isso o resultado de uma busca não
// tem endereço próprio, e a tela oferece "Limpar busca". `method="post"` no formulário é o cinto: se o navegador o
// enviar antes de a página hidratar, o termo ainda não vai para a URL (o envio normal é feito aqui, sem recarregar).
//
// O campo da lista do Acervo deixa o termo na ABA (`sessionStorage`, lido e apagado ao abrir esta tela), pelo mesmo
// motivo: nada de `?q=`. O resultado anterior fica na tela enquanto a nova busca roda.

type Visao = {
  termo: string;
  niveis: Nivel[];
  resultados: ResultadoDeBusca[];
  total: number;
  restante: number;
  proximo: number | null;
};
type Aviso = "falha" | "offline" | null;

const SEM_CONEXAO = "Sem conexão. A busca precisa de internet.";
const FALHA = "Não conseguimos buscar agora. Tente de novo.";
const AJUDA =
  "Procure por uma palavra em português, como “Pilatos”. A busca ignora acentos e maiúsculas e olha os resumos em português e o texto em inglês.";

function contagem(termo: string, total: number): string {
  if (total === 0) return `Nenhum resultado para “${termo}”`;
  if (total === 1) return `1 resultado para “${termo}”`;
  return `${total} resultados para “${termo}”`;
}

type Props = { oferecidos: readonly { nivel: Nivel; total: number }[] };

export function FormularioBusca({ oferecidos }: Props) {
  const [campo, setCampo] = useState("");
  const [nivel, setNivel] = useState<EscolhaDeNivel>(TODOS_OS_NIVEIS);
  const [visao, setVisao] = useState<Visao | null>(null);
  const [aviso, setAviso] = useState<Aviso>(null);
  // Estados de espera próprios, e não `useTransition`: as ações assíncronas de um mesmo `useTransition` entram numa
  // fila (a segunda só começa quando a primeira responde), e a busca refeita com outro Nível ou termo tem de sair
  // na hora, deixando a resposta da anterior ser descartada pela geração.
  const [buscando, setBuscando] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);
  // Muda a cada busca e a cada "Limpar busca": a resposta de um pedido de uma geração que já passou não muda a tela.
  const geracao = useRef(0);
  // A última busca PEDIDA (o termo já limpo e o Nível), mesmo que ainda não tenha respondido ou tenha falhado:
  // trocar o Nível repete ESTA busca, e não a que está na tela. Nulo quando não há busca (aberta ou limpa).
  const pedida = useRef<{ termo: string; escolha: EscolhaDeNivel } | null>(null);
  // O que "Tentar de novo" repete: a tentativa que falhou, com os parâmetros dela (a primeira página de uma busca, ou
  // a página seguinte de "Mostrar mais"), nunca a que por acaso está na tela.
  const repetir = useRef<(() => void) | null>(null);

  const semConexao = () => typeof navigator !== "undefined" && !navigator.onLine;

  async function chamar(termo: string, niveis: Nivel[], deslocamento: number) {
    const dados = new FormData();
    dados.set("termo", termo);
    for (const n of niveis) dados.append("nivel", n);
    if (deslocamento > 0) dados.set("deslocamento", String(deslocamento));
    try {
      return await buscarAcervo(dados);
    } catch {
      // A chamada nem chegou ao servidor.
      return null;
    }
  }

  function buscar(termoBruto: string, escolha: EscolhaDeNivel) {
    const termo = termoBruto.trim();
    // Toda chamada abre uma geração nova: a resposta de qualquer pedido anterior, ainda em voo, deixa de valer.
    geracao.current += 1;
    const nascida = geracao.current;
    setBuscando(false);
    setCarregandoMais(false);
    if (termo === "") {
      pedida.current = null;
      repetir.current = null;
      setVisao(null);
      setAviso(null);
      entrada.current?.focus();
      return;
    }
    pedida.current = { termo, escolha };
    repetir.current = () => buscar(termo, escolha);
    if (semConexao()) {
      setAviso("offline");
      return;
    }
    const niveis: Nivel[] = escolha === TODOS_OS_NIVEIS ? [] : [escolha];
    setBuscando(true);
    void (async () => {
      const r = await chamar(termo, niveis, 0);
      if (nascida !== geracao.current) return;
      setBuscando(false);
      if (!r) {
        setAviso(semConexao() ? "offline" : "falha");
        return;
      }
      if (!r.ok) {
        setAviso("falha");
        return;
      }
      setAviso(null);
      setVisao({
        termo: r.termo,
        niveis: r.niveis,
        resultados: r.resultados,
        total: r.total,
        restante: r.restante,
        proximo: r.proximo,
      });
    })();
  }

  // Foco no campo ao abrir; e, se a lista deixou um termo na aba, busca por ele (uma vez, apagando-o antes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda só ao montar
  useEffect(() => {
    entrada.current?.focus();
    let pendente: string | null = null;
    try {
      pendente = window.sessionStorage.getItem(CHAVE_DO_TERMO_PENDENTE);
      window.sessionStorage.removeItem(CHAVE_DO_TERMO_PENDENTE);
    } catch {
      // Sem armazenamento da aba (modo restrito): o campo abre vazio.
    }
    if (pendente?.trim()) {
      setCampo(pendente.slice(0, TERMO_DA_BUSCA_MAX));
      buscar(pendente.slice(0, TERMO_DA_BUSCA_MAX), TODOS_OS_NIVEIS);
    }
  }, []);

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    buscar(campo, nivel);
  }

  function trocarNivel(escolha: EscolhaDeNivel) {
    setNivel(escolha);
    // Com uma busca pedida, o filtro vale já: um filtro que só valesse no próximo envio pareceria quebrado.
    // Vale também para uma busca ainda sem resposta: ela é refeita com o Nível novo e a resposta da anterior é descartada.
    if (pedida.current) buscar(pedida.current.termo, escolha);
  }

  function limpar() {
    geracao.current += 1;
    pedida.current = null;
    repetir.current = null;
    setBuscando(false);
    setCarregandoMais(false);
    setCampo("");
    setVisao(null);
    setAviso(null);
    entrada.current?.focus();
  }

  function mostrarMais() {
    if (!visao || visao.proximo === null) return;
    carregarMais(visao.termo, visao.niveis, visao.proximo);
  }

  function carregarMais(termo: string, niveis: Nivel[], proximo: number) {
    repetir.current = () => carregarMais(termo, niveis, proximo);
    if (semConexao()) {
      setAviso("offline");
      return;
    }
    const nascida = geracao.current;
    setCarregandoMais(true);
    void (async () => {
      const r = await chamar(termo, niveis, proximo);
      if (nascida !== geracao.current) return;
      setCarregandoMais(false);
      if (!r?.ok) {
        setAviso(r === null && semConexao() ? "offline" : "falha");
        return;
      }
      setAviso(null);
      setVisao((atual) => {
        // A busca mudou enquanto esta página vinha: não mistura resultados de termos diferentes.
        if (!atual || atual.termo !== termo || atual.proximo !== proximo) return atual;
        return {
          ...atual,
          resultados: [...atual.resultados, ...r.resultados],
          total: r.total,
          restante: r.restante,
          proximo: r.proximo,
        };
      });
    })();
  }

  return (
    <div className="flex flex-col gap-6">
      <search>
        <form method="post" onSubmit={enviar} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="acervo-termo" className="text-label">
              Buscar no Acervo
            </label>
            <div className="flex gap-3">
              <Input
                ref={entrada}
                id="acervo-termo"
                type="search"
                name="termo"
                value={campo}
                onChange={(e) => setCampo(e.target.value)}
                maxLength={TERMO_DA_BUSCA_MAX}
                autoComplete="off"
                enterKeyHint="search"
                aria-describedby="acervo-ajuda"
                className="flex-1"
              />
              <Button type="submit" variant="secondary" aria-busy={buscando} disabled={buscando}>
                {buscando ? "Buscando…" : "Buscar"}
              </Button>
            </div>
            <p id="acervo-ajuda" className="text-meta text-ink-muted">
              {AJUDA}
            </p>
          </div>
          {oferecidos.length > 0 ? (
            <FiltroNivelRadio oferecidos={oferecidos} valor={nivel} onChange={trocarNivel} />
          ) : null}
        </form>
      </search>

      {aviso === "offline" ? <StatusMessage tipo="aviso">{SEM_CONEXAO}</StatusMessage> : null}
      {aviso === "falha" ? (
        <StatusMessage
          tipo="erro"
          acao={
            <Button variant="secondary" onClick={() => repetir.current?.()}>
              Tentar de novo
            </Button>
          }
        >
          {FALHA}
        </StatusMessage>
      ) : null}

      {visao ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p role="status" aria-live="polite" className="text-ui [overflow-wrap:anywhere]">
            {contagem(visao.termo, visao.total)}
          </p>
          <Button variant="secondary" onClick={limpar}>
            Limpar busca
          </Button>
        </div>
      ) : null}

      {visao && visao.resultados.length > 0 ? (
        <>
          <ul aria-label="Resultado da busca" className="flex flex-col">
            {visao.resultados.map((r) => (
              <ResultadoBusca key={`${r.tipo}:${r.fonteSlug}:${r.secaoSlug ?? ""}`} resultado={r} />
            ))}
          </ul>
          {visao.proximo !== null ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                variant="secondary"
                onClick={mostrarMais}
                disabled={carregandoMais}
                aria-busy={carregandoMais}
              >
                {carregandoMais ? "Buscando…" : "Mostrar mais resultados"}
              </Button>
              <p className="text-meta text-ink-muted">
                {visao.restante === 1
                  ? "Resta 1 resultado."
                  : `Restam ${visao.restante} resultados.`}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {visao && visao.resultados.length === 0 ? (
        <EmptyState
          titulo="Nenhuma Fonte encontrada"
          descricao="Tente outra palavra ou uma parte dela. A busca ignora acentos e maiúsculas e olha os resumos em português e o texto em inglês."
        />
      ) : null}
    </div>
  );
}
