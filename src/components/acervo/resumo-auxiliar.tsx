// Resumo e palavras-chave em português de uma seção (D-18): auxiliar de busca, escrito por IA. O rótulo
// "não é tradução nem foi revisado" fica SEMPRE visível e nunca recolhido: sem ele o resumo passaria por
// revisado (defeito crítico). Seção sem resumo: o componente não é renderizado e não deixa título solto.

type Props = { resumoPt: string | null; palavrasChavePt: string[]; id?: string };

export function ResumoAuxiliar({ resumoPt, palavrasChavePt, id = "resumo-auxiliar" }: Props) {
  if (!resumoPt) return null;
  return (
    <section
      lang="pt-BR"
      aria-labelledby={id}
      data-slot="resumo-auxiliar"
      className="flex flex-col gap-2 bg-paper-soft p-4"
    >
      <h2 id={id} className="text-label text-ink-muted">
        Resumo auxiliar
      </h2>
      <p data-slot="rotulo-resumo-auxiliar" className="text-meta text-ink-muted">
        Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado.
      </p>
      <p className="text-leitura">{resumoPt}</p>
      {palavrasChavePt.length > 0 ? (
        <p className="text-meta text-ink-muted">Palavras-chave: {palavrasChavePt.join(", ")}</p>
      ) : null}
    </section>
  );
}
