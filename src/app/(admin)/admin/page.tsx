import Link from "next/link";
import { exigirAdmin } from "@/modules/identidade/sessao";

export default async function PaginaAdministracao() {
  await exigirAdmin();
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Administração</h1>
      <p className="text-leitura">Convide e acompanhe as pessoas do grupo.</p>
      <Link href="/admin/convites" className="text-ui min-h-11 self-start underline">
        Convites
      </Link>
    </div>
  );
}
