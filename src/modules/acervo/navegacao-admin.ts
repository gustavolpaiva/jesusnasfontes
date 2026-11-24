import type { ItemDeNavegacao } from "@/components/shell/navegacao";

// Destinos de administração, que vivem no Menu (bloco "Administração", só para Admin) e não na faixa de
// navegação. Cada plano que cria uma rota de administração acrescenta o seu destino AQUI, junto da rota:
// link para rota que ainda não existe leva a página inexistente. Hoje "Convites" e "Fontes"; "Fichas a
// verificar" e "Graus propostos" entram com as telas que os criam.
export const DESTINOS_DE_ADMINISTRACAO: readonly ItemDeNavegacao[] = [
  { href: "/admin/convites", rotulo: "Convites" },
  { href: "/admin/acervo/fontes", rotulo: "Fontes" },
];
