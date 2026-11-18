import { SkeletonBlock } from "@/components/estado/skeleton-block";
import { AppShell } from "@/components/shell/app-shell";

// Carregando uma página: uma barra de Título e três de Corpo, dentro da casca.
export default function Carregando() {
  return (
    <AppShell>
      <div className="coluna-leitura">
        <SkeletonBlock />
      </div>
    </AppShell>
  );
}
