import { ApagarConta } from "./apagar-conta";
import { PRAZO_DAS_COPIAS } from "./aviso";
import { BaixarDados } from "./baixar-dados";
import { sessaoRecente } from "./sessao-recente";

// Os dois blocos "Exportar meus dados" e "Apagar minha conta", iguais na Conta (quem consentiu) e em
// "Seus dados" (quem não aceitou a versão atual do aviso): uma só cópia do texto e das ações, para as
// duas telas nunca divergirem. Componente de servidor; quem o usa põe o contêiner e as outras seções.

export const CLASSE_DO_BLOCO =
  "flex flex-col gap-3 border-t border-rule py-6 first:border-t-0 first:pt-0";
export const CLASSE_DO_TITULO = "text-label text-ink-muted";

type Props = {
  estudanteId: string;
  email: string;
  // Quando a sessão foi criada: sessão antiga pede o código por e-mail para apagar.
  sessaoCriadaEm: Date;
};

export function BlocosExportarEApagar({ estudanteId, email, sessaoCriadaEm }: Props) {
  return (
    <>
      <section aria-labelledby="conta-exportar" className={CLASSE_DO_BLOCO}>
        <h2 id="conta-exportar" className={CLASSE_DO_TITULO}>
          Exportar meus dados
        </h2>
        <p className="text-leitura">
          Baixe um arquivo com seu e-mail, o registro do aceite, suas Sessões, Anotações, conclusões
          e posição nas Trilhas.
        </p>
        <BaixarDados />
      </section>
      <section aria-labelledby="conta-apagar" className={CLASSE_DO_BLOCO}>
        <h2 id="conta-apagar" className={CLASSE_DO_TITULO}>
          Apagar minha conta
        </h2>
        <p className="text-leitura">
          Isto apaga a sua conta, as Anotações, as Sessões e o progresso. Não dá para desfazer. Se
          quiser guardar algo, baixe seus dados antes.
        </p>
        <ApagarConta
          estudanteId={estudanteId}
          email={email}
          precisaCodigo={!sessaoRecente(sessaoCriadaEm)}
          prazoDasCopias={PRAZO_DAS_COPIAS}
        />
      </section>
    </>
  );
}
