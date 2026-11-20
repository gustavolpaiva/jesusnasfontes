import Link from "next/link";
import { redirect } from "next/navigation";
import { exigirSessao } from "@/modules/identidade/sessao";
import { mudancasDoAviso, VERSAO_AVISO } from "@/modules/privacidade/aviso";
import { temConsentimentoAtual, ultimoAceite } from "@/modules/privacidade/consentimento";
import { TextoDoAviso } from "@/modules/privacidade/texto-do-aviso";
import { FormularioConsentimento } from "./formulario-consentimento";

// Antes do primeiro uso, e a cada nova versão do aviso. Depende do ambiente e da sessão.
export const dynamic = "force-dynamic";

export const metadata = { title: "Antes de começar" };

export default async function PaginaAceitar() {
  const { usuario } = await exigirSessao({ exigirConsentimento: false });
  // Quem já consentiu a versão atual não tem o que fazer aqui.
  if (await temConsentimentoAtual(usuario.id)) redirect("/trilhas");
  const anterior = await ultimoAceite(usuario.id);
  const mudancas = anterior ? mudancasDoAviso(VERSAO_AVISO) : [];
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Antes de começar</h1>
      <p className="text-leitura">
        {anterior
          ? "O aviso mudou. Leia de novo e confirme."
          : "Leia como cuidamos do que você escreve aqui. Você só entra depois de aceitar."}
      </p>
      {mudancas.length > 0 ? (
        <section aria-labelledby="aviso-mudou" className="flex flex-col gap-2">
          <h2 id="aviso-mudou" className="text-label text-ink-muted">
            O que mudou
          </h2>
          <ul className="text-leitura flex list-disc flex-col gap-1 pl-6">
            {mudancas.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <TextoDoAviso />
      <FormularioConsentimento />
      <Link
        href="/privacidade/seus-dados"
        className="text-ui inline-flex min-h-11 items-center justify-center underline"
      >
        Baixar ou apagar meus dados sem aceitar
      </Link>
    </div>
  );
}
