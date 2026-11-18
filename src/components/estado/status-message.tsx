import { CircleCheck, Info, SquareX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type TipoDeMensagem = "erro" | "aviso" | "sucesso" | "informacao";

// Estrutura de quatro partes: o tipo nunca depende só da cor.
//   1. forma do ícone (quadrado com X, triângulo, círculo com marca, círculo com i);
//   2. palavra de abertura em versalete (Erro., Atenção., Feito., Aviso.);
//   3. moldura: filete esquerdo de 4 px na cor do tipo mais contorno de 1 px --rule-strong;
//   4. papel: `role="alert"` para erro; `role="status"` para os demais.
const tipos = {
  erro: {
    Icone: SquareX,
    palavra: "Erro.",
    cor: "text-signal-error",
    filete: "border-l-signal-error",
  },
  aviso: {
    Icone: TriangleAlert,
    palavra: "Atenção.",
    cor: "text-signal-warning",
    filete: "border-l-signal-warning",
  },
  sucesso: {
    Icone: CircleCheck,
    palavra: "Feito.",
    cor: "text-signal-success",
    filete: "border-l-signal-success",
  },
  informacao: { Icone: Info, palavra: "Aviso.", cor: "text-ink", filete: "border-l-ink" },
} as const;

type Props = { tipo: TipoDeMensagem; children: ReactNode; className?: string; acao?: ReactNode };

export function StatusMessage({ tipo, children, className, acao }: Props) {
  const { Icone, palavra, cor, filete } = tipos[tipo];
  return (
    <Alert
      role={tipo === "erro" ? "alert" : "status"}
      data-tipo={tipo}
      className={cn(filete, className)}
    >
      <Icone aria-hidden="true" strokeWidth={1.5} className={cn("mt-1 size-5 shrink-0", cor)} />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <p className="text-ui [overflow-wrap:anywhere]">
          <span className={cn("text-label mr-2", cor)}>{palavra}</span>
          {children}
        </p>
        {acao}
      </div>
    </Alert>
  );
}
