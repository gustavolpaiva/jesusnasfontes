import { redirect } from "next/navigation";
import { lerSessao } from "@/modules/identidade/sessao";

// Sem tela própria: com sessão vai às Trilhas, sem sessão à entrada.
export default async function PaginaInicial() {
  redirect((await lerSessao()) ? "/trilhas" : "/entrar");
}
