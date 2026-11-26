"use client";

import { ehSinalDeNavegacao } from "@/app/(admin)/admin/convites/mensagens";
import { Button } from "@/components/ui/button";
import { conferirItemAction } from "@/modules/acervo/acoes-ficha";
import { MENSAGENS_FICHA, type ResultadoDeConferir } from "@/modules/acervo/painel-fichas";
import { useConferencia } from "./estado-da-conferencia";

// "Conferi no livro" (UI-SPEC tela 12): clique único, sem diálogo e sem desfazer. O ato é da pessoa que abriu o livro; o
// texto do botão já é a declaração, e a decisão que vale só vem depois, em "Marcar como verificada". O que vai ao
// servidor é a identidade do item e o hash que esta tela LEU: se o item mudou, o banco recusa e a tela pede para recarregar.

export function ConferirBotao({
  slug,
  itemId,
  hash,
  paginaFalada,
}: {
  slug: string;
  itemId: string;
  hash: string;
  /** "página 39 a 53": o nome acessível é "Conferi a página 39 a 53 no livro". */
  paginaFalada: string;
}) {
  const { ocupado, executar, mostrarRecusa, pedirFocoNoProximo } = useConferencia();
  async function aoClicar() {
    if (ocupado) return;
    mostrarRecusa(null);
    const r = await executar(async (): Promise<ResultadoDeConferir> => {
      try {
        return await conferirItemAction({ slug, itemId, hash });
      } catch (erro) {
        // Redirecionamento e "não encontrado" do Next passam adiante (pelo VALOR do digest: em produção o React põe digest
        // em qualquer erro de servidor, e só o campo não os distingue); o resto é falha de rede ou do servidor, e vira recusa.
        if (ehSinalDeNavegacao(erro)) throw erro;
        return { ok: false, motivo: "servidor", mensagem: MENSAGENS_FICHA.servidorConferir };
      }
    });
    if (!r) return;
    if (r.ok) pedirFocoNoProximo();
    else mostrarRecusa(r);
  }
  return (
    <Button
      type="button"
      variant="secondary"
      data-slot="conferir-botao"
      aria-disabled={ocupado || undefined}
      onClick={aoClicar}
    >
      {/* O nome acessível é "Conferi a página 39 a 53 no livro" (UI-SPEC) e nasce do conteúdo, não de `aria-label`: a
          página vai em texto só para leitor de tela, no meio da frase, e o nome continua contendo o rótulo visível
          (WCAG 2.5.3). */}
      {/* Um só filho do botão (que é `flex` com `gap`): senão o `gap` abre um buraco no meio do rótulo visível. */}
      <span>
        Conferi <span className="sr-only">a {paginaFalada} </span>no livro
      </span>
    </Button>
  );
}
