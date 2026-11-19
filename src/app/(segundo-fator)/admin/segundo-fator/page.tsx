import { prepararCadastro } from "@/modules/identidade/segundo-fator-cadastro";
import { exigirPrimeiroFatorDeAdmin } from "@/modules/identidade/sessao";
import { estadoDoCadastro } from "@/modules/identidade/sessao-mfa";
import { FluxoSegundoFator } from "./fluxo";

export const dynamic = "force-dynamic";

// Cadastro (primeiro acesso) ou verificação (entradas seguintes). Quem já verificou nesta sessão
// continua vendo esta mesma árvore: a ativação devolve os códigos de recuperação a ela, e o
// recarregamento que a ação provoca não pode trocá-la por outra tela antes de eles serem lidos.
export default async function PaginaSegundoFator() {
  const { usuario, segundoFatorVerificado } = await exigirPrimeiroFatorDeAdmin();
  if (segundoFatorVerificado) return <FluxoSegundoFator modo="verificado" material={null} />;
  const estado = await estadoDoCadastro(usuario.id);
  if (estado === "ativo") return <FluxoSegundoFator modo="verificacao" material={null} />;
  const material = await prepararCadastro(usuario.id);
  return <FluxoSegundoFator modo="cadastro" material={material} />;
}
