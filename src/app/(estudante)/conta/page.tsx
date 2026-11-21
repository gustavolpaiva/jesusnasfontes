import Link from "next/link";
import { Button } from "@/components/ui/button";
import { exigirSessao, sair } from "@/modules/identidade/sessao";
import {
  BlocosExportarEApagar,
  CLASSE_DO_BLOCO,
  CLASSE_DO_TITULO,
} from "@/modules/privacidade/blocos-exportar-e-apagar";
import { ultimoAceite } from "@/modules/privacidade/consentimento";
import { dataLonga } from "@/modules/privacidade/sessao-recente";

// Conta: dados, exportar, apagar e sair (PRIV-03, ANOT-05). Depende da sessão: nunca gerada no build.
export const dynamic = "force-dynamic";

export const metadata = { title: "Conta" };

const bloco = CLASSE_DO_BLOCO;
const titulo = CLASSE_DO_TITULO;

export default async function PaginaConta() {
  const { usuario, sessao } = await exigirSessao();
  const aceite = await ultimoAceite(usuario.id);
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Conta</h1>
      <div className="flex flex-col">
        <section aria-labelledby="conta-dados" className={bloco}>
          <h2 id="conta-dados" className={titulo}>
            Dados da conta
          </h2>
          <p className="text-leitura hyphens-none [overflow-wrap:anywhere]">
            <span className="text-ink-muted">E-mail: </span>
            <span data-testid="conta-email">{usuario.email}</span>
          </p>
          {aceite ? (
            <p className="text-leitura">
              Aviso de privacidade aceito: versão {aceite.versao}, em {dataLonga(aceite.aceitoEm)}.
            </p>
          ) : null}
          <Link href="/privacidade" className="text-ui inline-flex min-h-11 items-center underline">
            Ler o aviso
          </Link>
        </section>
        <BlocosExportarEApagar
          estudanteId={usuario.id}
          email={usuario.email}
          sessaoCriadaEm={sessao.criadaEm}
        />
        <section aria-labelledby="conta-sair" className={bloco}>
          <h2 id="conta-sair" className={titulo}>
            Sair
          </h2>
          <form action={sair}>
            <Button type="submit" variant="secondary">
              Sair deste aparelho
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
