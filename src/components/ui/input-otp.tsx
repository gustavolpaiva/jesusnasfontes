"use client";

import { OTPInput, OTPInputContext } from "input-otp";
import * as React from "react";
import { cn } from "@/lib/utils";

// Um único campo com as casas desenhadas por cima: o alvo de toque é o conjunto.
function InputOTP({
  className,
  containerClassName,
  maxLength = 6,
  children,
  ...props
}: Omit<React.ComponentProps<typeof OTPInput>, "render" | "children" | "maxLength"> & {
  containerClassName?: string;
  maxLength?: number;
  children: React.ReactNode;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      maxLength={maxLength}
      inputMode="numeric"
      autoComplete="one-time-code"
      containerClassName={cn("flex items-center has-disabled:opacity-50", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...(props as object)}
    >
      {children}
    </OTPInput>
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-group" className={cn("flex w-full gap-1", className)} {...props} />
  );
}

// Casa de 56 px de altura, largura flexível (de 36 a 48 px), folga de 4 px entre casas.
function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & { index: number }) {
  const contexto = React.useContext(OTPInputContext);
  const { char, isActive } = contexto?.slots[index] ?? {};
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "text-ui flex h-14 min-w-9 max-w-12 flex-1 items-center justify-center rounded-sm border border-input tabular-nums data-[active=true]:outline-2 data-[active=true]:outline-offset-2 data-[active=true]:outline-ring",
        className,
      )}
      {...props}
    >
      {char}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
