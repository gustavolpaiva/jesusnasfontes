import { unstable_rethrow } from "next/navigation";
import { type ConviteListado, listarConvites } from "@/modules/convites/consultas";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { FormularioConvite } from "./formulario-convite";
import { ListaConvites } from "./lista-convites";

// Depende da sessão e do banco: nunca gerada no build.
export const dynamic = "force-dynamic";

export const metadata = { title: "Convites" };

export default async function PaginaConvites() {
  // A guarda vem antes do try: quem não é Admin recebe a 404 (e não o "erro de carga").
  await exigirAdmin();
  let convites: ConviteListado[] | null = null;
  try {
    convites = await listarConvites();
  } catch (erro) {
    unstable_rethrow(erro);
  }
  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <h1 className="text-display">Convites</h1>
      <p className="text-leitura">
        Convide uma pessoa pelo e-mail. Ela recebe a mensagem com o endereço do site para pedir o
        acesso.
      </p>
      <FormularioConvite />
      <ListaConvites convites={convites} />
    </div>
  );
}
