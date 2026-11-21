"use client";

import Link from "next/link";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { lerAnotacao, salvarAnotacao } from "./anotacao";
import type { AnotacaoDoEstudo, ContaDoConflito } from "./anotacao-nucleo";
import { ConflictPanel } from "./conflict-panel";
import { ANOTACAO_MAX, estaVazio } from "./limite";
import {
  apagarRascunho,
  apagarRascunhosDeOutros,
  apagarTodosRascunhos,
  guardarRascunho,
  lerRascunho,
  lerRascunhos,
  segurarEscritor,
} from "./rascunho";
import { type EstadoDeSalvamento, SaveStatus } from "./save-status";

// Editor da Anotação (tela 9, ANOT-01 e ANOT-02). O texto é salvo sozinho 1,5 s depois de parar de digitar; a
// cada tecla o rascunho vai para este aparelho (`rascunho.ts`), então uma queda de conexão, um erro do servidor
// ou recarregar a página nunca levam o que foi escrito.
//
// O MODELO (rodada 10 da revisão; antes, cada conserto de reconciliação no navegador abria um caso novo):
//  - Cada montagem do editor é um ESCRITOR: um id e um número de envio que só cresce. Todo envio leva o id, o
//    número e a base (id e versão do servidor que o escritor confirmou). Quem ORDENA é o servidor
//    (`anotacao-nucleo.ts`): envio velho do mesmo escritor é recusado; envio novo do escritor que gravou por
//    último continua o que ele gravou; o de outro escritor só grava sobre a base, senão é conflito.
//  - O editor nunca adivinha se um envio chegou. Sem resposta, fica INCERTO e manda de novo o campo de agora
//    com o número seguinte; só uma resposta do servidor (gravado ou conflito) o tira de incerto.
//  - O rascunho é o estado do escritor (texto, base, último número) enquanto há algo não confirmado, e só o
//    escritor o escreve e apaga, segurando a trava dele (uma Web Lock). Quando o escritor some (aba fechada,
//    recarregada, ou o editor saiu da tela), o próximo editor do Estudo o RETOMA inteiro, pegando a trava: o
//    mesmo id e o número seguinte, então o envio antigo que ainda esteja a caminho chega velho e é recusado.
//
// Tudo o que os tratadores de evento leem fica em refs: o `online`, o `visibilitychange` e o temporizador não
// podem ler um estado velho do React. O texto é privado: nunca vai a URL, a título de aba, a `console` nem ao
// texto lido em voz alta; só ao servidor (por Server Action) e ao `localStorage` deste aparelho.

const ESPERA_MS = 1500;
// A nova tentativa depois de uma falha do servidor ou da rede com a conexão aparentemente de pé.
const NOVA_TENTATIVA_MS = 15_000;

/** O que o servidor confirmou ter. `corpo` nulo: não sabido (escritor retomado, até a primeira resposta). */
type Base = { id: string | null; versao: number; corpo: string | null };
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

const baseDe = (a: AnotacaoDoEstudo | null): Base =>
  a ? { id: a.id, versao: a.versao, corpo: a.corpo } : { id: null, versao: 0, corpo: "" };

const mesmoTexto = (a: string, b: string) => a === b || (estaVazio(a) && estaVazio(b));

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

  // Muda a cada montagem e desmontagem: toda continuação assíncrona guarda a geração em que nasceu e, se ela
  // já não é a de agora, não grava rascunho, não muda estado e não agenda nada.
  const geracao = useRef(0);
  // O escritor: id, número do último envio e se esta montagem segura a trava dele. Sem a trava, nada de
  // rascunho nem de envio (é o que impede dois editores de escreverem como o mesmo escritor).
  const montagemRef = useRef("");
  const seqRef = useRef(0);
  const donoRef = useRef(false);
  const textoRef = useRef(texto);
  const baseRef = useRef<Base>(baseDe(inicial));
  // O último envio não teve resposta: o servidor pode ou não tê-lo gravado.
  const incertoRef = useRef(false);
  const emVooRef = useRef(false);
  const conflitoRef = useRef(false);
  // A versão do servidor que o painel de conflito mostra: sobre ela vale o que a pessoa escolher.
  const contaDoConflito = useRef<Base>(baseDe(null));
  // O navegador passou a ser de outra conta: esta aba nunca mais envia nada (nem reenvia).
  const trocadaRef = useRef(false);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Há algo que o servidor não confirmou ter: o campo difere da base, ou o último envio ficou sem resposta.
  const sujo = useCallback(() => {
    const base = baseRef.current;
    return incertoRef.current || base.corpo === null || !mesmoTexto(textoRef.current, base.corpo);
  }, []);

  // O rascunho é o estado do escritor enquanto houver algo não confirmado; confirmado, sai. Só o dono escreve.
  const guardarLocal = useCallback(() => {
    if (!donoRef.current) return;
    if (!sujo()) {
      apagarRascunho(estudanteId, estudoId, montagemRef.current);
      return;
    }
    guardarRascunho(estudanteId, estudoId, {
      montagem: montagemRef.current,
      seq: seqRef.current,
      corpo: textoRef.current,
      versaoBase: baseRef.current.versao,
      baseId: baseRef.current.id,
      salvoEm: Date.now(),
    });
  }, [estudanteId, estudoId, sujo]);

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
    if (!donoRef.current || trocadaRef.current || conflitoRef.current || !sujo()) return;
    if (textoRef.current.length > ANOTACAO_MAX) {
      setEstado("limite");
      return;
    }
    // Um envio por vez; quem digitou durante ele é enviado quando a resposta chega.
    if (emVooRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setEstado("offline");
      return;
    }
    emVooRef.current = true;
    setEstado("salvando");
    const enviado = textoRef.current;
    const base = baseRef.current;
    // Antes de sair: o número deste envio vai para o rascunho e o escritor fica incerto até a resposta. Se a aba
    // fechar agora, quem retomar o escritor envia com o número seguinte, e este, se chegar depois, é velho.
    seqRef.current += 1;
    incertoRef.current = true;
    guardarLocal();
    let resposta: Awaited<ReturnType<typeof salvarAnotacao>>;
    try {
      resposta = await salvarAnotacao({
        estudanteId,
        estudoId,
        corpo: enviado,
        versaoBase: base.versao,
        baseId: base.id,
        montagem: montagemRef.current,
        seq: seqRef.current,
      });
    } catch {
      // Sem resposta (a chamada caiu, ou a resposta se perdeu): segue incerto e o texto segue neste aparelho.
      if (nascida !== geracao.current) return;
      emVooRef.current = false;
      if (typeof navigator !== "undefined" && !navigator.onLine) setEstado("offline");
      else {
        setEstado("falha");
        agendar(NOVA_TENTATIVA_MS);
      }
      return;
    }
    // O editor que enviou já saiu da tela: a resposta não é mais dele (quem o retomou envia o seguinte).
    if (nascida !== geracao.current) return;
    emVooRef.current = false;

    if (resposta.ok) {
      incertoRef.current = false;
      baseRef.current = baseDe(resposta.anotacao);
      guardarLocal();
      if (sujo()) {
        // Houve mais texto durante o envio: a vez dele chega em seguida, sobre a base nova.
        setEstado("ocioso");
        agendar(ESPERA_MS);
      } else setEstado("salvo");
      return;
    }
    switch (resposta.erro) {
      case "conflito":
        // O servidor respondeu: não está mais incerto. A base fica a de antes até a pessoa escolher, então o
        // rascunho, se a aba fechar agora, volta como o mesmo conflito.
        incertoRef.current = false;
        conflitoRef.current = true;
        contaDoConflito.current = {
          id: resposta.conta.id,
          versao: resposta.conta.versao,
          corpo: resposta.conta.corpo,
        };
        guardarLocal();
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

  // Sem nada a confirmar, o editor adota o que o servidor tem agora (o campo e a base juntos). Cobre a página
  // que veio da memória do navegador (voltar) e a Anotação mudada em outro aparelho.
  const conferirServidor = useCallback(async () => {
    if (!donoRef.current || trocadaRef.current || emVooRef.current || conflitoRef.current) return;
    if (sujo() || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    const antes = textoRef.current;
    const nascida = geracao.current;
    let lida: Awaited<ReturnType<typeof lerAnotacao>>;
    try {
      lida = await lerAnotacao(estudoId, estudanteId);
    } catch {
      return;
    }
    if (nascida !== geracao.current) return;
    if (!lida.ok) {
      trocadaRef.current = true;
      setEstado("sessao-trocada");
      return;
    }
    // A pessoa começou a escrever enquanto a resposta vinha: fica a base de antes, e o servidor dirá se mudou.
    if (emVooRef.current || conflitoRef.current || sujo() || textoRef.current !== antes) return;
    baseRef.current = baseDe(lida.anotacao);
    textoRef.current = lida.anotacao?.corpo ?? "";
    setTexto(textoRef.current);
  }, [estudanteId, estudoId, sujo]);

  // Ao abrir: decide QUAL escritor esta montagem é. Retoma o mais recente deste Estudo que nenhum editor vivo
  // segura (aba fechada, recarregada, ou este editor que saiu da tela e voltou); sem nenhum, nasce um novo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda uma vez por Estudo e por conta; o resto vive em refs
  useEffect(() => {
    geracao.current += 1;
    const nascida = geracao.current;
    let soltar = () => {};
    apagarRascunhosDeOutros(estudanteId);
    const textoAoAbrir = textoRef.current;
    const vivo = () => nascida === geracao.current;
    const virarDono = (solta: () => void, montagem: string) => {
      soltar = solta;
      montagemRef.current = montagem;
      donoRef.current = true;
    };
    void (async () => {
      // Uma volta da fila antes de pedir travas: a montagem que o React desfaz na hora (modo estrito em
      // desenvolvimento) sai sem pedir nenhuma, e não segura a do escritor que a montagem seguinte vai retomar.
      await null;
      if (!vivo()) return;
      for (const candidato of lerRascunhos(estudanteId, estudoId)) {
        // A pessoa já escreveu nesta montagem: ela é um escritor novo e o rascunho antigo fica para depois.
        if (textoRef.current !== textoAoAbrir) break;
        const solta = await segurarEscritor(candidato.montagem);
        if (!solta) continue; // um editor vivo, em outra aba, é o dono deste
        // Relido com a trava na mão: o dono anterior pode ter escrito até o instante em que saiu.
        const rascunho = lerRascunho(estudanteId, estudoId, candidato.montagem);
        if (!vivo() || !rascunho || textoRef.current !== textoAoAbrir) {
          solta();
          if (!vivo()) return;
          continue;
        }
        virarDono(solta, rascunho.montagem);
        seqRef.current = rascunho.seq;
        // O que o servidor tem depois do último envio dele não se sabe: o escritor retomado envia de novo, e a
        // resposta (gravado, ou o conflito com as duas versões) decide.
        baseRef.current = { id: rascunho.baseId, versao: rascunho.versaoBase, corpo: null };
        textoRef.current = rascunho.corpo;
        setTexto(rascunho.corpo);
        setEstado("recuperado");
        guardarLocal();
        if (navigator.onLine) agendar(ESPERA_MS);
        return;
      }
      const nova = crypto.randomUUID();
      // Um id recém-nascido não tem rascunho nem dono: a trava vem livre (sem a API, a degradação a dá como segura).
      const solta = (await segurarEscritor(nova)) ?? (() => {});
      if (!vivo()) {
        solta();
        return;
      }
      virarDono(solta, nova);
      // A pessoa pode ter escrito antes de a trava chegar: o rascunho e o envio começam agora.
      guardarLocal();
      if (sujo()) agendar(ESPERA_MS);
      else void conferirServidor();
    })();
    return () => {
      geracao.current += 1;
      donoRef.current = false;
      soltar();
      limparTemporizador();
    };
  }, [estudanteId, estudoId]);

  // Reenvio quando a conexão volta e quando a aba volta a ser vista; ao sair da aba, envia o que falta.
  useEffect(() => {
    const aoVoltarConexao = () => {
      if (sujo()) void enviarRef.current();
    };
    const aoPerderConexao = () => {
      if (sujo() && !conflitoRef.current && !trocadaRef.current) setEstado("offline");
    };
    const aoMudarVisibilidade = () => {
      if (sujo()) void enviarRef.current();
      else if (document.visibilityState === "visible") void conferirServidor();
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
    // O que o servidor mostra agora vira o texto e a base: nada mais a confirmar, e o rascunho sai.
    baseRef.current = contaDoConflito.current;
    textoRef.current = contaDoConflito.current.corpo ?? "";
    setTexto(textoRef.current);
    conflitoRef.current = false;
    setConflito(null);
    guardarLocal();
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
