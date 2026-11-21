import Link from "next/link";

// 404 dentro das telas de Estudante (ex.: Estudo que não existe): o layout do grupo já traz a casca
// (cabeçalho, navegação, rodapé), então aqui vai só o conteúdo. O `not-found.tsx` da raiz monta a
// própria casca e, aninhado aqui, repetia cabeçalho, link de salto e conteúdo principal.
export default function NaoEncontradaDoEstudante() {
  return (
    <div className="coluna-leitura flex flex-col items-start gap-6">
      <h1 className="text-display">Página não encontrada</h1>
      <p className="text-leitura">Este endereço não existe ou mudou.</p>
      <Link
        href="/trilhas"
        className="text-ui inline-flex min-h-12 w-full items-center justify-center rounded-sm border border-rubric bg-rubric px-6 font-semibold text-rubric-ink no-underline transition-colors duration-150 hover:border-rubric-hover hover:bg-rubric-hover sm:w-auto"
      >
        Ir para as Trilhas
      </Link>
    </div>
  );
}
