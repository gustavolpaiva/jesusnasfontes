"use client";

import Link from "next/link";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { lerAnotacao, salvarAnotacao } from "./anotacao";
import type { AnotacaoDoEstudo, ContaDoConflito } from "./anotacao-nucleo";
import { ConflictPanel } from "./conflict-panel";
import { ANOTACAO_MAX, estaVazio } from "./limite";
import {
  apagarRascunhoDestaMontagem,
  apagarRascunhosDeOutros,
  apagarRascunhosIguais,
  apagarTodosRascunhos,
  guardarRascunho,
  lerRascunhos,
} from "./rascunho";
import { type EstadoDeSalvamento, SaveStatus } from "./save-status";

// Editor da Anotação (tela 9, ANOT-01 e ANOT-02). O texto é salvo sozinho 1,5 s depois de parar de
// digitar; a cada tecla o rascunho vai para este aparelho (`rascunho.ts`), então uma queda de conexão, um
// erro do servidor ou recarregar a página nunca levam o que foi escrito. A Anotação do servidor é a
// verdade; o editor sempre diz sobre QUAL versão o texto foi escrito (`base`: id e versão) e o servidor
// recusa, devolvendo o conflito, o envio cuja base não é mais a dele. Nada é sobrescrito calado.
//
// Tudo o que os tratadores de evento leem fica em refs: o `online`, o `visibilitychange` e o temporizador
// não podem ler um estado velho do React. O texto é privado: nunca vai a URL, a título de aba, a `console`
// nem ao texto lido em voz alta; só ao servidor (por Server Action) e ao `localStorage` deste aparelho.

const ESPERA_MS = 1500;
// A nova tentativa depois de uma falha do servidor ou da rede com a conexão aparentemente de pé.
const NOVA_TENTATIVA_MS = 15_000;

type Base = { id: string | null; versao: number; corpo: string };
type Conflito = {
  conta: { corpo: string; em: Date | null };
  rascunho: { corpo: string; em: Date };
};

type Props = {
  estudanteId: string;
  estudoId: string;
  /** O que o servidor tinha quando a página foi montada. */
  inicial: AnotacaoDoEstudo | null;
};

const SEM_BASE: Base = { id: null, versao: 0, corpo: "" };

const baseDe = (a: AnotacaoDoEstudo | null): Base =>
  a ? { id: a.id, versao: a.versao, corpo: a.corpo } : SEM_BASE;

function contaParaPainel(conta: ContaDoConflito): Conflito["conta"] {
  return { corpo: conta.corpo, em: conta.atualizadoEm ? new Date(conta.atualizadoEm) : null };
}

export function AnotacaoEditor({
  estudanteId: estudanteIdDaTela,
  estudoId: estudoIdDaTela,
  inicial,
}: Props) {
  // A identidade é capturada UMA vez, na montagem, e nunca muda: é "quem abriu a tela" (e qual Estudo). Uma
  // prop que mude depois (a página refeita com outra sessão) não é herdada; a página também troca a `key`
  // do componente com a conta, então outra conta é um editor novo, sem o texto nem a base de quem abriu.
  const [{ estudanteId, estudoId }] = useState(() => ({
    estudanteId: estudanteIdDaTela,
    estudoId: estudoIdDaTela,
  }));
  const [texto, setTexto] = useState(inicial?.corpo ?? "");
  const [estado, setEstado] = useState<EstadoDeSalvamento>("ocioso");
  const [conflito, setConflito] = useState<Conflito | null>(null);

  // Uma chave de rascunho por MONTAGEM do editor, e uma geração que muda a cada montagem e a cada desmontagem:
  // toda continuação assíncrona (resposta de envio, temporizador, conferência do servidor) guarda a geração em
  // que nasceu e, se ela já não é a de agora, não grava rascunho, não muda estado e não agenda nada.
  const [donoDoRascunho] = useState(() => crypto.randomUUID());
  const geracao = useRef(0);
  const textoRef = useRef(texto);
  const baseRef = useRef<Base>(baseDe(inicial));
  const conflitoRef = useRef(false);
  // A versão do servidor que o painel de conflito mostra: sobre ela vale o que a pessoa escolher.
  const contaDoConflito = useRef<Base>(SEM_BASE);
  const emVooRef = useRef(false);
  // O texto que está a caminho do servidor (resposta ainda não chegou): enquanto houver um, o servidor pode
  // passar a ter esse texto, então a base antiga já não diz o que a edição de agora muda.
  const enviadoRef = useRef<string | null>(null);
  // O navegador passou a ser de outra conta: esta aba nunca mais envia nada (nem reenvia).
  const trocadaRef = useRef(false);
  const reenviarRef = useRef(false);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sujo = useCallback(() => {
    const t = textoRef.current;
    const base = baseRef.current;
    if (estaVazio(t) && base.id === null) return false;
    return t !== base.corpo;
  }, []);

  // O rascunho local acompanha o texto, sobre a base conhecida; sem diferença, não há rascunho.
  const guardarLocal = useCallback(() => {
    // Com um envio pendente, o campo que difere do texto a caminho tem de ficar no rascunho MESMO que seja igual
    // à base antiga (apagar tudo num Estudo sem Anotação, por exemplo): é a única cópia da exclusão.
    const aCaminho = emVooRef.current ? enviadoRef.current : null;
    const difereDoQueVoa = aCaminho !== null && textoRef.current !== aCaminho;
    if (!sujo() && !difereDoQueVoa) {
      // Sem diferença para o servidor o rascunho desta montagem (que espelha o campo) sai na hora, mesmo que o
      // que ele guardava antes fosse outro texto; dos outros, saem só os de texto igual ao do servidor.
      apagarRascunhoDestaMontagem(estudanteId, estudoId, donoDoRascunho);
      apagarRascunhosIguais(estudanteId, estudoId, baseRef.current.corpo);
      return;
    }
    const base = baseRef.current;
    guardarRascunho(estudanteId, estudoId, donoDoRascunho, {
      corpo: textoRef.current,
      versaoBase: base.versao,
      baseId: base.id,
      salvoEm: Date.now(),
      ...(aCaminho !== null ? { aCaminho: true } : {}),
    });
  }, [donoDoRascunho, estudanteId, estudoId, sujo]);

  const limparTemporizador = useCallback(() => {
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = null;
  }, []);

  // `enviar` e `agendar` se chamam (o envio agenda o reenvio de quem digitou durante ele): referência por
  // ref, para as duas poderem ser estáveis.
  const enviarRef = useRef<() => Promise<void>>(async () => {});

  const agendar = useCallback(
    (ms: number) => {
      limparTemporizador();
      const nascida = geracao.current;
      temporizador.current = setTimeout(() => {
        if (nascida === geracao.current) void enviarRef.current();
      }, ms);
    },
    [limparTemporizador],
  );

  const enviar = useCallback(async () => {
    const nascida = geracao.current;
    limparTemporizador();
    if (trocadaRef.current || conflitoRef.current || !sujo()) return;
    if (textoRef.current.length > ANOTACAO_MAX) {
      setEstado("limite");
      return;
    }
    if (emVooRef.current) {
      reenviarRef.current = true;
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setEstado("offline");
      return;
    }
    emVooRef.current = true;
    setEstado("salvando");
    const enviado = textoRef.current;
    enviadoRef.current = enviado;
    const usada = baseRef.current;
    let resposta: Awaited<ReturnType<typeof salvarAnotacao>>;
    try {
      resposta = await salvarAnotacao({
        estudanteId,
        estudoId,
        corpo: enviado,
        versaoBase: usada.versao,
        baseId: usada.id,
      });
    } catch {
      // A chamada nem chegou (ou voltou quebrada): o texto segue neste aparelho.
      if (nascida !== geracao.current) return;
      emVooRef.current = false;
      enviadoRef.current = null;
      if (typeof navigator !== "undefined" && !navigator.onLine) setEstado("offline");
      else {
        setEstado("falha");
        agendar(NOVA_TENTATIVA_MS);
      }
      return;
    }
    // O editor que enviou já saiu da tela (outro Estudo, ou desmontado): a resposta não é mais dele.
    if (nascida !== geracao.current) return;
    emVooRef.current = false;
    enviadoRef.current = null;
    const digitouDepois = textoRef.current !== enviado;

    if (resposta.ok) {
      baseRef.current = baseDe(resposta.anotacao);
      guardarLocal();
      if (digitouDepois || reenviarRef.current) {
        // Houve mais texto durante o envio: o rascunho já tem a base nova, e a vez dele chega em seguida.
        reenviarRef.current = false;
        setEstado("ocioso");
        if (sujo()) agendar(ESPERA_MS);
        else setEstado("salvo");
      } else setEstado("salvo");
      return;
    }
    reenviarRef.current = false;
    switch (resposta.erro) {
      case "conflito":
        conflitoRef.current = true;
        limparTemporizador();
        contaDoConflito.current = {
          id: resposta.conta.id,
          versao: resposta.conta.versao,
          corpo: resposta.conta.corpo,
        };
        setConflito({
          conta: contaParaPainel(resposta.conta),
          rascunho: { corpo: textoRef.current, em: new Date() },
        });
        setEstado("ocioso");
        return;
      case "limite":
        setEstado("limite");
        return;
      case "sessao-trocada":
        // Outra conta entrou neste navegador: o texto fica só na tela (e no rascunho de A, que B nunca lê).
        trocadaRef.current = true;
        limparTemporizador();
        setEstado("sessao-trocada");
        return;
      case "conta-apagada":
        // A conta não existe mais: o rascunho deste aparelho vai embora com ela.
        apagarTodosRascunhos();
        window.location.assign("/entrar?apagada=1");
        return;
      default:
        setEstado("falha");
        agendar(NOVA_TENTATIVA_MS);
    }
  }, [agendar, estudanteId, estudoId, guardarLocal, limparTemporizador, sujo]);

  useEffect(() => {
    enviarRef.current = enviar;
  }, [enviar]);

  // Confere o que o servidor tem agora e adota se a pessoa não escreveu nada que dependa da versão velha.
  // Cobre a página que veio do cache do navegador (voltar) e a Anotação mudada em outro aparelho.
  const conferirServidor = useCallback(async () => {
    if (trocadaRef.current || emVooRef.current || conflitoRef.current || sujo()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const antes = textoRef.current;
    const nascida = geracao.current;
    let atual: AnotacaoDoEstudo | null;
    try {
      const lida = await lerAnotacao(estudoId, estudanteId);
      if (nascida !== geracao.current) return;
      if (!lida.ok) {
        trocadaRef.current = true;
        setEstado("sessao-trocada");
        return;
      }
      atual = lida.anotacao;
    } catch {
      return;
    }
    // A pessoa começou a escrever enquanto a resposta vinha: a base velha fica, e o servidor dirá se mudou.
    if (emVooRef.current || conflitoRef.current || sujo() || textoRef.current !== antes) return;
    const base = baseRef.current;
    if ((atual?.id ?? null) === base.id && (atual?.versao ?? 0) === base.versao) return;
    baseRef.current = baseDe(atual);
    textoRef.current = atual?.corpo ?? "";
    setTexto(textoRef.current);
    apagarRascunhosIguais(estudanteId, estudoId, textoRef.current);
  }, [estudanteId, estudoId, sujo]);

  // Ao abrir: rascunhos de outra conta saem; um rascunho desta conta é recuperado (mesma base) ou vira
  // conflito (o servidor andou depois dele). Sem rascunho, confere se a página não está velha.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda uma vez por Estudo e por conta; o resto vive em refs
  useEffect(() => {
    geracao.current += 1;
    apagarRascunhosDeOutros(estudanteId);
    const base = baseRef.current;
    const textoAoAbrir = textoRef.current;
    // Qual rascunho a página recupera: dos rascunhos desta conta para este Estudo (de qualquer aba, inclusive
    // os de antes de recarregar), o MAIS RECENTE que difere do servidor. Os outros continuam guardados e vêm
    // nas próximas aberturas, um por vez. O que já é igual ao servidor não tem o que perder e sai.
    apagarRascunhosIguais(estudanteId, estudoId, base.corpo, { confirmado: false });
    const rascunho = lerRascunhos(estudanteId, estudoId)[0] ?? null;
    const igualABase =
      rascunho !== null &&
      (rascunho.corpo === base.corpo || (estaVazio(rascunho.corpo) && base.id === null));
    if (rascunho?.aCaminho && igualABase) {
      // Escrito com um envio sem resposta e igual à base que a página tinha: o servidor pode ter recebido o
      // texto que estava a caminho. Só o servidor, relido, diz se a edição (por exemplo, apagar tudo) ainda
      // vale; se ele andou, as duas versões vão à pessoa, se não, o rascunho é igual a ele e sai.
      void (async () => {
        const nascida = geracao.current;
        let lida: Awaited<ReturnType<typeof lerAnotacao>>;
        try {
          lida = await lerAnotacao(estudoId, estudanteId);
        } catch {
          return;
        }
        if (nascida !== geracao.current || textoRef.current !== textoAoAbrir) return;
        if (!lida.ok) {
          trocadaRef.current = true;
          setEstado("sessao-trocada");
          return;
        }
        const fresca = lida.anotacao;
        if ((fresca?.id ?? null) === base.id && (fresca?.versao ?? 0) === base.versao) {
          apagarRascunhosIguais(estudanteId, estudoId, base.corpo);
          return;
        }
        conflitoRef.current = true;
        contaDoConflito.current = baseDe(fresca);
        setConflito({
          conta: { corpo: fresca?.corpo ?? "", em: fresca ? new Date(fresca.atualizadoEm) : null },
          rascunho: { corpo: rascunho.corpo, em: new Date(rascunho.salvoEm) },
        });
      })();
    } else if (rascunho) {
      const mesmaBase = rascunho.baseId === base.id && rascunho.versaoBase === base.versao;
      if (mesmaBase) {
        textoRef.current = rascunho.corpo;
        setTexto(rascunho.corpo);
        setEstado("recuperado");
        guardarLocal();
        if (navigator.onLine) agendar(ESPERA_MS);
      } else {
        // O servidor mudou depois de este texto ser escrito: as duas versões vão à pessoa.
        conflitoRef.current = true;
        contaDoConflito.current = base;
        setConflito({
          conta: { corpo: base.corpo, em: inicial ? new Date(inicial.atualizadoEm) : null },
          rascunho: { corpo: rascunho.corpo, em: new Date(rascunho.salvoEm) },
        });
      }
    } else {
      void conferirServidor();
    }
    return () => {
      geracao.current += 1;
      limparTemporizador();
    };
  }, [estudanteId, estudoId]);

  // Reenvio quando a conexão volta e quando a aba volta a ser vista; ao sair da aba, envia o que falta.
  useEffect(() => {
    const aoVoltarConexao = () => {
      if (sujo() && !conflitoRef.current) void enviarRef.current();
    };
    const aoPerderConexao = () => {
      if (sujo() && !conflitoRef.current && !trocadaRef.current) setEstado("offline");
    };
    const aoMudarVisibilidade = () => {
      if (document.visibilityState === "hidden") {
        if (sujo() && !conflitoRef.current) void enviarRef.current();
      } else if (sujo()) {
        if (!conflitoRef.current) void enviarRef.current();
      } else {
        void conferirServidor();
      }
    };
    window.addEventListener("online", aoVoltarConexao);
    window.addEventListener("offline", aoPerderConexao);
    document.addEventListener("visibilitychange", aoMudarVisibilidade);
    return () => {
      window.removeEventListener("online", aoVoltarConexao);
      window.removeEventListener("offline", aoPerderConexao);
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
    };
  }, [conferirServidor, sujo]);

  function aoDigitar(evento: ChangeEvent<HTMLTextAreaElement>) {
    const valor = evento.target.value;
    textoRef.current = valor;
    setTexto(valor);
    // O primeiro caractere já vai para o rascunho local; o servidor espera a pausa.
    guardarLocal();
    if (conflitoRef.current) return;
    if (valor.length > ANOTACAO_MAX) {
      limparTemporizador();
      setEstado("limite");
      return;
    }
    if (!navigator.onLine) {
      limparTemporizador();
      setEstado("offline");
      return;
    }
    if (!sujo()) {
      limparTemporizador();
      setEstado("ocioso");
      return;
    }
    setEstado("ocioso");
    agendar(ESPERA_MS);
  }

  function manterAConta() {
    if (!conflito) return;
    // O que o servidor mostra agora vira o texto; o rascunho (já copiável no painel) é descartado.
    const conta = contaDoConflito.current;
    baseRef.current = conta;
    textoRef.current = conta.corpo;
    setTexto(conta.corpo);
    // Descartado de propósito: sai o que tem EXATAMENTE o texto que o painel mostrava (se outra aba escreveu
    // mais depois, esse texto fica).
    apagarRascunhosIguais(estudanteId, estudoId, conflito.rascunho.corpo);
    conflitoRef.current = false;
    setConflito(null);
    setEstado("salvo");
  }

  function usarORascunho() {
    if (!conflito) return;
    // O rascunho passa a valer SOBRE a versão do servidor que a pessoa acabou de ver.
    baseRef.current = contaDoConflito.current;
    textoRef.current = conflito.rascunho.corpo;
    setTexto(conflito.rascunho.corpo);
    conflitoRef.current = false;
    setConflito(null);
    guardarLocal();
    void enviar();
  }

  return (
    <section data-slot="anotacao" className="flex flex-col gap-3">
      <label htmlFor="anotacao-campo" className="text-label">
        Minha anotação
      </label>
      <Textarea
        id="anotacao-campo"
        value={texto}
        onChange={aoDigitar}
        readOnly={conflito !== null || estado === "sessao-trocada"}
        aria-describedby="anotacao-ajuda anotacao-estado"
        aria-invalid={estado === "limite" ? true : undefined}
        autoComplete="off"
        className="min-h-[calc(3lh+1.5rem)] resize-none border-rule-strong"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p id="anotacao-ajuda" className="text-meta min-w-0 text-ink-muted">
          Privada: nenhum Estudante nem Admin lê pelo site. Salva sozinha.{" "}
          <Link href="/privacidade" className="underline underline-offset-2">
            Como funciona
          </Link>
        </p>
        <SaveStatus id="anotacao-estado" estado={estado} />
      </div>
      {conflito ? (
        <ConflictPanel
          conta={conflito.conta}
          rascunho={conflito.rascunho}
          aoManterConta={manterAConta}
          aoUsarRascunho={usarORascunho}
        />
      ) : null}
    </section>
  );
}
