import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";

// 404: mesma estrutura do 500 (error.tsx). Fica fora do grupo (publico), então monta o próprio AppShell.
export default function NaoEncontrada() {
  return (
    <AppShell>
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
    </AppShell>
  );
}
