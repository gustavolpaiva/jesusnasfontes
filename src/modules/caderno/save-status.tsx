import { ArchiveRestore, Check, Ellipsis, SquareX, WifiOff } from "lucide-react";

// Estado de salvamento da Anotação (tela 9): sempre texto MAIS ícone (a cor nunca é o único sinal),
// `role="status"` e `aria-live="polite"`. O conflito não mora aqui: tem o painel próprio. A região fica
// montada o tempo todo, mesmo vazia: leitor de tela só anuncia mudança numa região que já existia.

export type EstadoDeSalvamento =
  | "ocioso"
  | "salvo"
  | "salvando"
  | "offline"
  | "falha"
  | "recuperado"
  | "limite"
  | "sessao-trocada";

const FALHA = "Não foi possível salvar. O texto continua neste aparelho e vamos tentar de novo.";
const LIMITE =
  "A Anotação passou do limite de 20 000 caracteres. Apague um trecho para continuar salvando.";

const TROCADA =
  "Este navegador entrou com outra conta. O texto desta aba não foi enviado. Recarregue a página.";

const textos = {
  salvo: { Icone: Check, texto: "Salvo" },
  salvando: { Icone: Ellipsis, texto: "Salvando…" },
  offline: { Icone: WifiOff, texto: "Sem conexão: rascunho guardado neste aparelho." },
  recuperado: {
    Icone: ArchiveRestore,
    texto: "Rascunho recuperado deste aparelho. Ainda não foi enviado.",
  },
  falha: { Icone: SquareX, texto: FALHA, erro: true },
  limite: { Icone: SquareX, texto: LIMITE, erro: true },
  "sessao-trocada": { Icone: SquareX, texto: TROCADA, erro: true },
} as const;

type Props = { estado: EstadoDeSalvamento; id?: string };

export function SaveStatus({ estado, id }: Props) {
  const conteudo = estado === "ocioso" ? null : textos[estado];
  const Icone = conteudo?.Icone;
  const erro = conteudo !== null && "erro" in conteudo;
  return (
    <p
      id={id}
      data-slot="save-status"
      data-estado={estado}
      role="status"
      aria-live="polite"
      className="text-meta empty:absolute flex min-w-0 items-start gap-2 text-ink-muted [overflow-wrap:anywhere]"
    >
      {conteudo && Icone ? (
        <>
          <Icone
            aria-hidden="true"
            strokeWidth={1.5}
            className={`mt-0.5 size-4 shrink-0 ${erro ? "text-signal-error" : ""}`}
          />
          <span>
            {erro ? (
              <>
                <span className="text-label not-italic text-signal-error">Erro.</span>{" "}
              </>
            ) : null}
            {conteudo.texto}
          </span>
        </>
      ) : null}
    </p>
  );
}
