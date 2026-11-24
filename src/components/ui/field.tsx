import type * as React from "react";
import { StatusMessage } from "@/components/estado/status-message";
import { Algarismos } from "@/components/ui/algarismos";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Agrupa rótulo, controle, ajuda e erro. O erro tem sempre ícone e a palavra "Erro".
function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset data-slot="field-set" className={cn("flex flex-col gap-4", className)} {...props} />
  );
}

function FieldLegend({ className, children, ...props }: React.ComponentProps<"legend">) {
  return (
    <legend data-slot="field-legend" className={cn("text-label mb-2", className)} {...props}>
      <Algarismos>{children}</Algarismos>
    </legend>
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn("flex w-full flex-col gap-6", className)}
      {...props}
    />
  );
}

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="field" className={cn("flex w-full flex-col gap-2", className)} {...props} />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex flex-1 flex-col gap-1", className)}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("w-fit", className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-meta text-ink-muted", className)}
      {...props}
    />
  );
}

function FieldError({ children, className }: { children?: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <StatusMessage tipo="erro" className={className}>
      {children}
    </StatusMessage>
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
};
