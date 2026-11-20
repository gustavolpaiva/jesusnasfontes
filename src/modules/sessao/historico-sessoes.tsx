import { EmptyState } from "@/components/estado/empty-state";
import type { SessaoDoHistorico } from "./consultas";
import { formatarData, formatarDuracao, formatarHora } from "./formato";

// Histórico das Sessões (tela 5, item 5): as 15 últimas, a mais recente primeiro. Cada linha traz data e
// hora, duração, "de X até Y" e, em itálico, a Anotação da Sessão. A Anotação é texto privado da pessoa e
// só chega aqui pela leitura com RLS da própria conta; é texto, nunca HTML.

export function HistoricoSessoes({ sessoes }: { sessoes: SessaoDoHistorico[] }) {
  return (
    <section aria-labelledby="historico-sessoes" className="flex flex-col gap-3">
      <h2 id="historico-sessoes" className="text-heading">
        Sessões
      </h2>
      {sessoes.length === 0 ? (
        <EmptyState
          titulo="Nenhuma Sessão ainda"
          descricao="Faça check-in em um Estudo para começar a registrar suas Sessões."
        />
      ) : (
        <ul className="flex flex-col">
          {sessoes.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 border-b border-rule py-3">
              <p className="text-ui [overflow-wrap:anywhere]">
                {formatarData(s.checkInEm)}, {formatarHora(s.checkInEm)} ·{" "}
                {formatarDuracao(s.minutos)} · de {s.de} até {s.ate}
              </p>
              {s.anotacao ? (
                <p className="text-ui whitespace-pre-line text-ink-muted italic [overflow-wrap:anywhere]">
                  {s.anotacao}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
