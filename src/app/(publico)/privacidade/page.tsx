import { TextoDoAviso } from "@/modules/privacidade/texto-do-aviso";

// Página pública, só leitura: o mesmo texto que o Estudante vê antes do primeiro uso. Depende do
// ambiente (responsável e contato), então nunca é gerada no build.
export const dynamic = "force-dynamic";

export const metadata = { title: "Aviso de privacidade" };

export default function PaginaAvisoPublico() {
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Aviso de privacidade</h1>
      <TextoDoAviso />
    </div>
  );
}
