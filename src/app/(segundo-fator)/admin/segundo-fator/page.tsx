import { retornoSeguro } from "@/modules/identidade/retorno-segundo-fator";
import { prepararCadastro } from "@/modules/identidade/segundo-fator-cadastro";
import { exigirPrimeiroFatorDeAdmin } from "@/modules/identidade/sessao";
import { estadoDoCadastro } from "@/modules/identidade/sessao-mfa";
import { FluxoSegundoFator } from "./fluxo";

export const dynamic = "force-dynamic";

// Cadastro (primeiro acesso) ou verificação (entradas seguintes). Quem já verificou nesta sessão
// continua vendo esta mesma árvore: a ativação devolve os códigos de recuperação a ela, e o
// recarregamento que a ação provoca não pode trocá-la por outra tela antes de eles serem lidos.
//
// `?retorno=` (plano 02-18, T-02-47): quem foi mandado para cá no meio de um ato (marcar uma ficha como verificada) volta
// ao mesmo lugar depois de confirmar. O valor só vale se for um caminho interno da lista fechada de prefixos
// (`retorno-segundo-fator.ts`); qualquer outro é ignorado, aqui e de novo na ação.
export default async function PaginaSegundoFator({
  searchParams,
}: {
  searchParams: Promise<{ retorno?: string | string[] }>;
}) {
  const { usuario, segundoFatorVerificado } = await exigirPrimeiroFatorDeAdmin();
  const { retorno: bruto } = await searchParams;
  const retorno = retornoSeguro(Array.isArray(bruto) ? bruto[0] : bruto);
  if (segundoFatorVerificado)
    return <FluxoSegundoFator modo="verificado" material={null} retorno={retorno} />;
  const estado = await estadoDoCadastro(usuario.id);
  if (estado === "ativo")
    return <FluxoSegundoFator modo="verificacao" material={null} retorno={retorno} />;
  const material = await prepararCadastro(usuario.id);
  return <FluxoSegundoFator modo="cadastro" material={material} retorno={retorno} />;
}
