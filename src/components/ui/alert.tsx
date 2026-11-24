import type * as React from "react";
import { Algarismos } from "@/components/ui/algarismos";
import { cn } from "@/lib/utils";

// Moldura de mensagem: contorno de 1 px --rule-strong e filete esquerdo de 4 px. A cor do filete
// vem de `className` (border-l-signal-error etc.). O papel (alert ou status) é de quem usa.
function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      className={cn(
        "text-ui relative flex w-full gap-3 rounded-sm border border-l-4 border-input bg-transparent p-4 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertTitle({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-title" className={cn("text-label", className)} {...props}>
      <Algarismos>{children}</Algarismos>
    </div>
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("text-ui", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
