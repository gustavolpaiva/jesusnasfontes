import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Chips: versalete, canto de 2 px. O estado nunca depende só da cor: a borda muda de forma.
const badgeVariants = cva(
  "text-label inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border px-2 py-1 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-ink bg-transparent text-ink",
        // "Fonte em preparação": borda tracejada, não é botão.
        preparacao: "border-dashed border-ink-muted bg-transparent text-ink-muted",
        // Nível de fonte (fase 2): borda sólida em --ink.
        nivel: "border-ink bg-transparent text-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
