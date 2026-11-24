import type { ItemDeNavegacao } from "@/components/shell/navegacao";

// Destinos de administração, que vivem no Menu (bloco "Administração", só para Admin) e não na faixa de
// navegação. Cada plano que cria uma rota de administração acrescenta o seu destino AQUI, junto da rota:
// link para rota que ainda não existe leva a página inexistente. Hoje "Convites", "Fontes" e "Fichas a
// verificar"; "Graus propostos" entra com a tela que o cria. A contagem pendente de cada área aparece na entrada
// da administração (`/admin`), que a lê do banco; o Menu só leva ao destino.
export const DESTINOS_DE_ADMINISTRACAO: readonly ItemDeNavegacao[] = [
  { href: "/admin/convites", rotulo: "Convites" },
  { href: "/admin/acervo/fontes", rotulo: "Fontes" },
  { href: "/admin/acervo/fichas", rotulo: "Fichas a verificar" },
];
