"use client";

import { Label as LabelPrimitive } from "radix-ui";
import type * as React from "react";
import { Algarismos } from "@/components/ui/algarismos";
import { cn } from "@/lib/utils";

function Label({
  className,
  children,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("text-label text-ink-muted select-none peer-disabled:opacity-50", className)}
      {...props}
    >
      <Algarismos>{children}</Algarismos>
    </LabelPrimitive.Root>
  );
}

export { Label };
