"use client";

import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { fazerCheckOut } from "./acoes";
import { ANOTACAO_DA_SESSAO_MAX } from "./anotacao";
import { posicaoDaFolha } from "./teclado";

// Check-out (tela 6): folha que sobe de baixo, com a Anotação da Sessão opcional. A Anotação é privada
// como uma Anotação (D-10) e a ajuda diz isso. Sem conexão o erro de conexão aparece e nada fica em fila.
// O texto digitado NUNCA se perde em erro: o estado do campo mora aqui e só se limpa depois do sucesso.
// O envio chama a ação em `onSubmit`, sem `action`: o React 19 reinicia o formulário ao fim de uma
// `action`, e o campo voltaria vazio justo no erro (a lição do consentimento, plano 01-14).

const SEM_CONEXAO = "Sem conexão. Tente de novo quando a conexão voltar.";

type Aviso = { tipo: "erro" | "informacao"; texto: string } | null;

export type SessaoEncerrada = { minutos: number; de: string; ate: string };

type Props = {
  /** O Estudo em que a pessoa está, quando o check-out vem de um Estudo. */
  estudoSlugAtual: string | null;
  aoEncerrar: (encerrada: SessaoEncerrada) => void;
};

// Acompanha a área visível: com o teclado de tela aberto, a folha sobe e encolhe para caber nela.
function useFolhaSobOTeclado(ativo: boolean): CSSProperties | undefined {
  const [estilo, setEstilo] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const visual = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!ativo || !visual) return;
    const medir = () => {
      const { alturaMaxima, deslocamentoDaBase } = posicaoDaFolha(window.innerHeight, visual);
      setEstilo({ maxHeight: alturaMaxima, bottom: deslocamentoDaBase });
    };
    medir();
    visual.addEventListener("resize", medir);
    visual.addEventListener("scroll", medir);
    return () => {
      visual.removeEventListener("resize", medir);
      visual.removeEventListener("scroll", medir);
      setEstilo(undefined);
    };
  }, [ativo]);
  return estilo;
}

export function CheckoutSheet({ estudoSlugAtual, aoEncerrar }: Props) {
  const [aberta, setAberta] = useState(false);
  const [texto, setTexto] = useState("");
  const [aviso, setAviso] = useState<Aviso>(null);
  const [pendente, iniciar] = useTransition();
  // Depois de um check-out que deu certo o foco vai para a mensagem de sucesso (quem a lê é a faixa), não
  // para o botão que sai de cena.
  const encerrou = useRef(false);
  const estilo = useFolhaSobOTeclado(aberta);
  const roteador = useRouter();
  // Outra aba já encerrou: esta faixa está desatualizada. Refazê-la com a folha aberta a fecharia e levaria
  // o texto embora; ela se refaz quando a folha é fechada.
  const desatualizada = useRef(false);

  function aoMudarAbertura(valor: boolean) {
    setAberta(valor);
    if (valor) setAviso(null);
    else if (desatualizada.current) {
      desatualizada.current = false;
      roteador.refresh();
    }
  }

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const dados = new FormData();
    dados.set("anotacao", texto);
    if (estudoSlugAtual) dados.set("estudoSlug", estudoSlugAtual);
    setAviso(null);
    iniciar(async () => {
      let resultado: Awaited<ReturnType<typeof fazerCheckOut>>;
      try {
        resultado = await fazerCheckOut(dados);
      } catch {
        // A chamada nem chegou ao servidor: sem conexão. Não há fila, e o texto continua no campo.
        setAviso({ tipo: "erro", texto: SEM_CONEXAO });
        return;
      }
      if (resultado.ok) {
        encerrou.current = true;
        setTexto("");
        setAberta(false);
        aoEncerrar({ minutos: resultado.minutos, de: resultado.de, ate: resultado.ate });
        return;
      }
      if (resultado.erro === "sem-sessao-aberta") {
        desatualizada.current = true;
        setAviso({
          tipo: "informacao",
          texto: "Esta Sessão já foi encerrada em outra aba. O que você escreveu não foi guardado.",
        });
      } else if (resultado.erro === "anotacao-invalida") {
        setAviso({
          tipo: "erro",
          texto: `A Anotação da Sessão tem no máximo ${ANOTACAO_DA_SESSAO_MAX} caracteres. O que você escreveu continua aqui. Apare o texto e tente de novo.`,
        });
      } else {
        setAviso({
          tipo: "erro",
          texto:
            "Não conseguimos encerrar a Sessão. O que você escreveu continua aqui. Tente de novo.",
        });
      }
    });
  }

  return (
    <Sheet open={aberta} onOpenChange={aoMudarAbertura}>
      <SheetTrigger asChild>
        <Button variant="secondary">Fazer check-out</Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-dvh overflow-y-auto"
        style={estilo}
        onCloseAutoFocus={(evento) => {
          if (encerrou.current) {
            evento.preventDefault();
            encerrou.current = false;
          }
        }}
      >
        <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
          <SheetHeader className="pr-16">
            <SheetTitle>Encerrar a Sessão</SheetTitle>
            <SheetDescription>
              Se quiser, deixe uma Anotação da Sessão. Ela é privada, como as suas Anotações.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4">
            <Field>
              <FieldLabel htmlFor="anotacao-da-sessao">Anotação da Sessão (opcional)</FieldLabel>
              <Textarea
                id="anotacao-da-sessao"
                name="anotacao"
                value={texto}
                maxLength={ANOTACAO_DA_SESSAO_MAX}
                rows={3}
                aria-describedby="contagem-da-anotacao"
                onChange={(e) => setTexto(e.target.value)}
              />
              <FieldDescription id="contagem-da-anotacao">
                {texto.length} de {ANOTACAO_DA_SESSAO_MAX} caracteres
              </FieldDescription>
            </Field>
            {aviso ? <StatusMessage tipo={aviso.tipo}>{aviso.texto}</StatusMessage> : null}
          </div>
          <SheetFooter>
            <Button
              type="submit"
              variant="primary"
              pendente={pendente}
              rotuloPendente="Encerrando…"
            >
              Encerrar Sessão
            </Button>
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                Voltar
              </Button>
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
