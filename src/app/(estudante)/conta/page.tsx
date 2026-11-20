import Link from "next/link";
import { Button } from "@/components/ui/button";
import { exigirSessao, sair } from "@/modules/identidade/sessao";
import { PRAZO_DAS_COPIAS } from "@/modules/privacidade/aviso";
import { ultimoAceite } from "@/modules/privacidade/consentimento";
import { dataLonga, sessaoRecente } from "@/modules/privacidade/sessao-recente";
import { ApagarConta } from "./apagar-conta";
import { BaixarDados } from "./baixar-dados";

// Conta: dados, exportar, apagar e sair (PRIV-03, ANOT-05). Depende da sessão: nunca gerada no build.
export const dynamic = "force-dynamic";

export const metadata = { title: "Conta" };

const bloco = "flex flex-col gap-3 border-t border-rule py-6 first:border-t-0 first:pt-0";
const titulo = "text-label text-ink-muted";

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
        <section aria-labelledby="conta-exportar" className={bloco}>
          <h2 id="conta-exportar" className={titulo}>
            Exportar meus dados
          </h2>
          <p className="text-leitura">
            Baixe um arquivo com seu e-mail, o registro do aceite, suas Sessões, Anotações,
            conclusões e posição nas Trilhas.
          </p>
          <BaixarDados />
        </section>
        <section aria-labelledby="conta-apagar" className={bloco}>
          <h2 id="conta-apagar" className={titulo}>
            Apagar minha conta
          </h2>
          <p className="text-leitura">
            Isto apaga a sua conta, as Anotações, as Sessões e o progresso. Não dá para desfazer. Se
            quiser guardar algo, baixe seus dados antes.
          </p>
          <ApagarConta
            email={usuario.email}
            precisaCodigo={!sessaoRecente(sessao.criadaEm)}
            prazoDasCopias={PRAZO_DAS_COPIAS}
          />
        </section>
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
