import { linhaDaVersao, secoesDoAviso } from "./aviso";

// O texto do aviso, igual na página pública (/privacidade) e na de consentimento. Os sete blocos têm
// título em versalete e filete entre si; nenhum cartão. Componente de servidor: lê o ambiente.
export function TextoDoAviso() {
  const secoes = secoesDoAviso();
  return (
    <div className="flex flex-col">
      {secoes.map((secao) => (
        <section
          key={secao.id}
          aria-labelledby={`aviso-${secao.id}`}
          className="flex flex-col gap-2 border-t border-rule py-4 first:border-t-0 first:pt-0"
        >
          <h2 id={`aviso-${secao.id}`} className="text-label text-ink-muted">
            {secao.titulo}
          </h2>
          {secao.paragrafos.map((p) => (
            <p
              key={p}
              // O responsável e o contato (nome, endereço de e-mail) nunca são hifenizados: um
              // endereço partido com hífen pode ser lido errado.
              className={`text-leitura [overflow-wrap:anywhere] ${secao.id === "responsavel" ? "hyphens-none" : ""}`}
            >
              {p}
            </p>
          ))}
        </section>
      ))}
      <p className="text-meta border-t border-rule pt-4 text-ink-muted">{linhaDaVersao()}</p>
    </div>
  );
}
