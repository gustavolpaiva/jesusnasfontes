import Link from "next/link";
import { redirect } from "next/navigation";
import { exigirSessao } from "@/modules/identidade/sessao";
import { BlocosExportarEApagar } from "@/modules/privacidade/blocos-exportar-e-apagar";
import { temConsentimentoAtual } from "@/modules/privacidade/consentimento";

// Exportar e apagar para quem não aceitou a versão atual do aviso (nunca aceitou, ou recusa uma versão
// nova). Decisão do dono, 20/11/2026: levar os próprios dados e apagar a conta não dependem de aceitar o
// tratamento. É a ÚNICA exceção ao portão do consentimento, e vale só para estas duas ações, na casca sem
// navegação. Quem já consentiu usa a Conta.
export const dynamic = "force-dynamic";

export const metadata = { title: "Seus dados" };

export default async function PaginaSeusDados() {
  const { usuario, sessao } = await exigirSessao({ exigirConsentimento: false });
  if (await temConsentimentoAtual(usuario.id)) redirect("/conta");
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Seus dados</h1>
      <p className="text-leitura">
        Você ainda não aceitou a versão atual do aviso, então o resto do site continua fechado. Aqui
        você pode baixar os seus dados ou apagar a conta.
      </p>
      <div className="flex flex-col">
        <BlocosExportarEApagar
          estudanteId={usuario.id}
          email={usuario.email}
          sessaoCriadaEm={sessao.criadaEm}
        />
      </div>
      <Link
        href="/privacidade/aceitar"
        className="text-ui inline-flex min-h-11 items-center underline"
      >
        Voltar ao aviso
      </Link>
    </div>
  );
}
