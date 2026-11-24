import Link from "next/link";
import { Button } from "@/components/ui/button";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { FormularioFonte } from "../formulario-fonte";

export const dynamic = "force-dynamic";
export const metadata = { title: "Incluir Fonte" };

export default async function PaginaIncluirFonte() {
  await exigirAdmin();
  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/admin/acervo/fontes">Voltar às Fontes</Link>
      </Button>
      <h1 className="text-display">Incluir Fonte</h1>
      <FormularioFonte />
    </div>
  );
}
