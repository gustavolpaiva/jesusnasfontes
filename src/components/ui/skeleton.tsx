import { cn } from "@/lib/utils";

// Barra reta em --rule. O pulso só existe fora de prefers-reduced-motion.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-sm bg-border motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
