import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErroDoAcervo } from "@/components/acervo/erro-do-acervo";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { listarFontesPorNivel } from "@/modules/acervo/consultas-lista";
import type { Nivel } from "@/modules/acervo/schemas";
import { exigirSessao } from "@/modules/identidade/sessao";
import { FormularioBusca } from "./formulario-busca";

export const metadata = { title: "Buscar no Acervo" };

// Busca do Acervo (ACER-05): o termo NUNCA está na URL (a busca é um POST, ver `formulario-busca.tsx`), então a
// página não lê parâmetro algum e a resposta não é guardada em cache. Só os Níveis que têm Fonte viram item do
// filtro (D-13); quem decide o que o Estudante enxerga é a política de linha do banco.
export const dynamic = "force-dynamic";

export default async function PaginaDeBusca() {
  await exigirSessao();
  let oferecidos: { nivel: Nivel; total: number }[] = [];
  try {
    oferecidos = (await listarFontesPorNivel(null)).oferecidos;
  } catch (erro) {
    // Só o contexto e o código vão ao registro: o erro do banco não entra nele.
    registrarErro("acervo-busca-niveis", erro);
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Buscar no Acervo</h1>
        <ErroDoAcervo />
      </div>
    );
  }
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <header className="flex flex-col items-start gap-3">
        <Button asChild variant="ghost" className="-ml-4">
          <Link href="/acervo">
            <ArrowLeft aria-hidden="true" strokeWidth={1.5} />
            Voltar ao Acervo
          </Link>
        </Button>
        <h1 className="text-display">Buscar no Acervo</h1>
      </header>
      <FormularioBusca oferecidos={oferecidos} />
    </div>
  );
}
