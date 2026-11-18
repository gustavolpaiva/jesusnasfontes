import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "text-ui min-h-12 w-full min-w-0 rounded-sm border border-input bg-transparent px-3 text-foreground transition-colors duration-150 placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal-error",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
