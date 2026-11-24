import { textoDoProgresso } from "@/modules/acervo/estado-da-ficha";

// Progresso de conferência de uma ficha (UI-SPEC tela 12): filete de 4 px mais o TEXTO "7 de 12 páginas conferidas",
// que leva a informação; a barra é só reforço visual. Mesmo molde do `ProgressRule` das Trilhas, com o texto da ficha.
export function ProgressoDaFicha({
  conferidos,
  total,
  titulo,
}: {
  conferidos: number;
  total: number;
  titulo: string;
}) {
  const texto = textoDoProgresso(conferidos, total);
  const percentual = total > 0 ? Math.min(100, Math.round((conferidos / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-4 py-1" data-slot="progresso-da-ficha">
      <div
        role="progressbar"
        aria-label={`Páginas conferidas de ${titulo}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={conferidos}
        aria-valuetext={texto}
        className="relative h-1 min-w-16 flex-1 overflow-hidden rounded-sm bg-border"
      >
        <div className="h-full bg-primary" style={{ width: `${percentual}%` }} />
      </div>
      <p className="text-meta shrink-0 text-ink-muted">{texto}</p>
    </div>
  );
}
