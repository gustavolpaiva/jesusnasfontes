"use client";

import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Caixa de 24 px dentro de uma área de toque de 44 px.
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group inline-flex size-11 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="flex size-6 items-center justify-center rounded-sm border border-input bg-transparent text-primary-foreground transition-colors duration-150 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-aria-invalid:border-signal-error">
        <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
          <Check aria-hidden="true" strokeWidth={2} className="size-4" />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
