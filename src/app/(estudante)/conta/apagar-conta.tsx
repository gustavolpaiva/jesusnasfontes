"use client";

import { Trash2 } from "lucide-react";
import { type FormEvent, startTransition, useActionState, useState } from "react";
import { StatusMessage } from "@/components/estado/status-message";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  apagarConta,
  type EstadoApagar,
  pedirCodigoReautenticacao,
} from "@/modules/privacidade/apagar";

type EstadoLocal = EstadoApagar & { conexao?: boolean };

const ERROS: Record<NonNullable<EstadoLocal["erro"]>, string> = {
  digitacao: "Digite APAGAR, em letras maiúsculas, para confirmar.",
  codigo: "Código inválido ou vencido. Confira os 6 dígitos ou peça um código novo.",
  limite: "Muitas tentativas. Espere um pouco e peça um código novo.",
  "unico-admin":
    "Esta é a única conta de Admin do grupo. Nomeie outro Admin antes de apagar a conta.",
  servidor: "Não conseguimos apagar a conta agora. Nada foi apagado. Tente de novo.",
};

type Props = {
  // E-mail da conta: o código de 6 dígitos vai para ele.
  email: string;
  // A sessão não é recente: o código por e-mail é obrigatório.
  precisaCodigo: boolean;
  prazoDasCopias: string;
};

// Confirmação em diálogo no centro, com o foco inicial em "Cancelar" (o Radix o faz em AlertDialog) e
// o botão destrutivo só preenchido dentro dele. O texto digitado não se perde em erro: o envio chama
// a ação à mão (`onSubmit`), sem `action`, para o React não reiniciar o formulário.
export function ApagarConta({ email, precisaCodigo: precisaDeInicio, prazoDasCopias }: Props) {
  const [aberto, setAberto] = useState(false);
  const [codigo, setCodigo] = useState<"nenhum" | "enviando" | "enviado" | "limite" | "falha">(
    "nenhum",
  );
  const [estado, acao, pendente] = useActionState(
    async (anterior: EstadoLocal, dados: FormData): Promise<EstadoLocal> => {
      try {
        return await apagarConta(anterior, dados);
      } catch (erro) {
        // Sem conexão a chamada nem chega ao servidor; com conexão, o erro segue para a tela de erro.
        if (typeof navigator !== "undefined" && !navigator.onLine) return { conexao: true };
        throw erro;
      }
    },
    {} as EstadoLocal,
  );
  const precisaCodigo = precisaDeInicio || estado.precisaCodigo === true;
  const erro = estado.conexao
    ? "Sem conexão. Tente de novo quando a conexão voltar."
    : estado.erro
      ? ERROS[estado.erro]
      : null;

  async function enviarCodigo() {
    setCodigo("enviando");
    try {
      const r = await pedirCodigoReautenticacao();
      setCodigo(r.ok ? "enviado" : r.erro);
    } catch {
      setCodigo("falha");
    }
  }

  function aoAbrir(valor: boolean) {
    setAberto(valor);
    // O código sai uma vez por abertura, só quando a sessão não é recente.
    if (valor && precisaCodigo && codigo === "nenhum") void enviarCodigo();
  }

  function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => acao(dados));
  }

  return (
    <AlertDialog open={aberto} onOpenChange={aoAbrir}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="destructive" className="self-start">
          <Trash2 aria-hidden="true" strokeWidth={1.5} />
          Apagar minha conta
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={aoEnviar} noValidate className="grid gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar a conta?</AlertDialogTitle>
            <AlertDialogDescription>
              Tudo o que é seu será apagado deste site. Cópias de segurança do banco podem guardar
              os dados por até {prazoDasCopias}. Para confirmar, digite APAGAR.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {precisaCodigo ? (
            <div className="flex flex-col gap-3">
              <p className="text-ui [overflow-wrap:anywhere]">
                Por segurança, confirme que é você. Enviamos um código de 6 dígitos para {email}.
              </p>
              <Field>
                <FieldLabel htmlFor="codigo-apagar">Código de 6 dígitos</FieldLabel>
                <Input
                  id="codigo-apagar"
                  name="codigo"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  aria-invalid={estado.erro === "codigo" ? true : undefined}
                />
              </Field>
              {codigo === "limite" ? (
                <StatusMessage tipo="erro">
                  Muitos pedidos de código. Espere alguns minutos e tente de novo.
                </StatusMessage>
              ) : null}
              {codigo === "falha" ? (
                <StatusMessage tipo="erro">
                  Não conseguimos enviar o código agora. Tente de novo.
                </StatusMessage>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={enviarCodigo}
                pendente={codigo === "enviando"}
                rotuloPendente="Enviando…"
              >
                Enviar o código de novo
              </Button>
            </div>
          ) : null}
          <Field>
            <FieldLabel htmlFor="confirmacao-apagar">Digite APAGAR</FieldLabel>
            <Input
              id="confirmacao-apagar"
              name="confirmacao"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={estado.erro === "digitacao" ? true : undefined}
            />
          </Field>
          {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
          {/* Cancelar vem primeiro no DOM: a ordem de Tab é a visual (em coluna, Cancelar em cima e o
              destrutivo embaixo; em linha, Cancelar à esquerda). */}
          <AlertDialogFooter className="flex-col sm:flex-row">
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button
              type="submit"
              variant="destructiveSolid"
              pendente={pendente}
              rotuloPendente="Apagando…"
            >
              Apagar minha conta
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
