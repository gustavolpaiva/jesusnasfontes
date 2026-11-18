// Primeiro foco da página. O alvo é main#conteudo (tabIndex -1), definido no AppShell.
export function LinkDeSalto() {
  return (
    <a
      href="#conteudo"
      className="sr-only text-ui font-semibold focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:flex focus:min-h-12 focus:items-center focus:bg-ink focus:px-4 focus:text-paper"
    >
      Pular para o conteúdo
    </a>
  );
}
