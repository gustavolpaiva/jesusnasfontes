"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { AppearanceControls } from "./appearance-controls";
import type { ItemDeNavegacao } from "./navegacao";

type Props = {
  // Os mesmos destinos da faixa inferior; só para quem está autenticado.
  itens?: readonly ItemDeNavegacao[];
  // Ação de sair (Server Action do plano de autenticação). Sem ela, o item não aparece.
  acaoSair?: () => Promise<void>;
};

const ligacao =
  "text-ui flex min-h-11 items-center rounded-sm px-2 text-foreground no-underline transition-colors duration-150 hover:bg-paper-soft";

// Menu: folha pela direita com navegação, Aparência, Créditos, Aviso de privacidade e Sair.
// Esc fecha e o foco volta ao botão de Menu (comportamento do Radix).
export function MenuSheet({ itens = [], acaoSair }: Props) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Abrir menu"
          className="flex size-11 items-center justify-center rounded-sm text-ink transition-colors duration-150 hover:bg-paper-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Menu aria-hidden="true" size={22} strokeWidth={1.5} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        mostrarFechar={false}
        aria-describedby={undefined}
        className="overflow-y-auto"
      >
        <SheetHeader className="sticky top-0 z-10 flex-row items-center justify-between border-b border-border bg-background">
          <SheetTitle>Menu</SheetTitle>
          <SheetClose
            aria-label="Fechar menu"
            className="flex size-11 items-center justify-center rounded-sm transition-colors duration-150 hover:bg-paper-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X aria-hidden="true" strokeWidth={1.5} className="size-5" />
          </SheetClose>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          {itens.length > 0 ? (
            <nav aria-label="Navegação do menu">
              <ul className="flex flex-col gap-2">
                {itens.map((item) => (
                  <li key={item.href}>
                    <SheetClose asChild>
                      <Link href={item.href} className={ligacao}>
                        {item.rotulo}
                      </Link>
                    </SheetClose>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <section aria-labelledby="menu-aparencia" className="flex flex-col gap-4">
            <h2 id="menu-aparencia" className="text-label text-ink-muted">
              Aparência
            </h2>
            <AppearanceControls />
          </section>
          <ul className="flex flex-col gap-2 border-t border-border pt-4">
            <li>
              <SheetClose asChild>
                <Link href="/creditos" className={ligacao}>
                  Créditos
                </Link>
              </SheetClose>
            </li>
            <li>
              <SheetClose asChild>
                <Link href="/privacidade" className={ligacao}>
                  Aviso de privacidade
                </Link>
              </SheetClose>
            </li>
          </ul>
        </div>
        {/* Sair fica preso ao rodapé da folha: continua o último item, mas sempre à vista. Dentro da
            rolagem ele ficava abaixo da dobra em tela de notebook, e nada indicava que havia mais. */}
        {acaoSair ? (
          <div className="sticky bottom-0 z-10 mt-auto border-t border-border bg-background px-4 py-3">
            <form action={acaoSair}>
              <button type="submit" className={`${ligacao} w-full text-left`}>
                Sair
              </button>
            </form>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
