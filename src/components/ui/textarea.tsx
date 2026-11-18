import type * as React from "react";
import { cn } from "@/lib/utils";

// Anotação: no tamanho de leitura, três linhas no mínimo, cresce com o texto.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "text-leitura field-sizing-content min-h-24 w-full rounded-sm border border-input bg-transparent px-3 py-3 text-foreground transition-colors duration-150 placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal-error",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
