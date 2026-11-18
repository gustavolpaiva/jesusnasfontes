import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

type Props = { titulo: string; descricao: string; acao?: ReactNode };

// Título, uma frase e uma ação. Sem ilustração.
export function EmptyState({ titulo, descricao, acao }: Props) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{titulo}</EmptyTitle>
        <EmptyDescription>{descricao}</EmptyDescription>
      </EmptyHeader>
      {acao ? <EmptyContent>{acao}</EmptyContent> : null}
    </Empty>
  );
}
