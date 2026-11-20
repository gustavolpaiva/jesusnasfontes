import { registrarErro } from "@/lib/registro";
import { listarCaderno, type PaginaDoCaderno } from "@/modules/caderno/caderno";
import { exigirSessao } from "@/modules/identidade/sessao";
import { BuscaCaderno } from "./busca-caderno";

export const metadata = { title: "Caderno" };

// O Caderno é de uma pessoa só: a resposta nunca é guardada em cache (também o cabeçalho
// `Cache-Control: no-store`, em next.config.ts). Nenhum parâmetro de busca na URL: a busca é um POST.
export const dynamic = "force-dynamic";

export default async function PaginaCaderno() {
  const { usuario } = await exigirSessao();
  let inicial: PaginaDoCaderno | null = null;
  try {
    inicial = await listarCaderno(usuario.id);
  } catch (erro) {
    // Só o contexto e o código vão ao registro; a tela mostra o erro do contrato com "Tentar de novo".
    registrarErro("caderno-listar", erro);
  }
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-display">Caderno</h1>
        <p className="text-leitura">Todas as suas Anotações, num só lugar.</p>
      </header>
      <BuscaCaderno inicial={inicial} />
    </div>
  );
}
