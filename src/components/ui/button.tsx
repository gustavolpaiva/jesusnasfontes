import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Quatro variantes do contrato: primary (preenchido em rubrica), secondary (contorno),
// ghost (só texto) e destructive (contorno em --signal-error). destructiveSolid é só o botão
// de confirmação do diálogo de apagar. Alturas mínimas: 44 px, 48 px no primário.
const buttonVariants = cva(
  "text-ui inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border px-4 text-center transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        primary:
          "min-h-12 border-primary bg-primary px-6 font-semibold text-primary-foreground hover:border-rubric-hover hover:bg-rubric-hover",
        secondary: "min-h-11 border-input bg-transparent text-foreground hover:bg-paper-soft",
        ghost: "min-h-11 border-transparent bg-transparent text-foreground hover:bg-paper-soft",
        destructive:
          "min-h-11 border-signal-error bg-transparent text-signal-error hover:bg-paper-soft",
        destructiveSolid:
          "min-h-12 border-signal-error bg-signal-error px-6 font-semibold text-signal-error-ink hover:opacity-90",
      },
      size: {
        default: "",
        // Botão de ícone: 44 por 44 px.
        icon: "size-11 px-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    // Estado pendente: troca o rótulo por `rotuloPendente`, marca aria-busy e desabilita.
    // Nunca há ícone giratório.
    pendente?: boolean;
    rotuloPendente?: string;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  pendente = false,
  rotuloPendente,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      aria-busy={pendente || undefined}
      disabled={disabled || pendente}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {pendente && rotuloPendente ? rotuloPendente : children}
    </Comp>
  );
}

export { Button, buttonVariants };
