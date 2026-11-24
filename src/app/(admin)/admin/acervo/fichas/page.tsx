import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { ChipDaFicha } from "@/components/acervo/chip-da-ficha";
import { ProgressoDaFicha } from "@/components/acervo/progresso-da-ficha";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type FichaNaFila, filaDeFichas } from "@/modules/acervo/consultas-admin";
import { MENSAGENS_FICHA } from "@/modules/acervo/painel-fichas";
import { exigirAdmin } from "@/modules/identidade/sessao";

// A fila de fichas a verificar (ACER-07, UI-SPEC tela 12): uma linha por ficha, com o estado em texto e forma, o progresso
// em texto e a linha inteira clicável. Ordem do contrato: prontas, em conferência, rascunhos, alteradas, verificadas.
// Os estados são derivados no servidor a partir do que o banco guarda; a tela só os mostra.
export const dynamic = "force-dynamic";
export const metadata = { title: "Fichas a verificar" };

const BASE = "/admin/acervo/fichas";

function Linha({ f }: { f: FichaNaFila }) {
  const meta = [f.autor, f.ano === null ? null : String(f.ano)].filter(Boolean).join(", ");
  return (
    <li
      data-slot="linha-ficha-admin"
      data-estado={f.estado}
      className="relative flex flex-col gap-2 border-b border-rule py-4 last:border-b-0 hover:bg-paper-soft has-[a:focus-visible]:bg-paper-soft"
    >
      <Link
        href={`${BASE}/${f.slug}`}
        className="text-ui flex min-h-11 items-center rounded-sm font-semibold text-ink no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
      >
        {f.titulo}
      </Link>
      {meta ? (
        <p className="text-meta -mt-1 text-ink-muted [overflow-wrap:anywhere]">{meta}</p>
      ) : null}
      <ChipDaFicha estado={f.estado} verificadaEm={f.verificadaEm} />
      <ProgressoDaFicha conferidos={f.conferidos} total={f.total} titulo={f.titulo} />
    </li>
  );
}

export default async function PaginaDaFila() {
  const sessao = await exigirAdmin();
  let fila: FichaNaFila[] | null = null;
  try {
    fila = await filaDeFichas(sessao.sessao.id);
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-fila-de-fichas", erro);
  }

  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <h1 className="text-display">Fichas a verificar</h1>
      {fila === null ? (
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <Link href={BASE}>{MENSAGENS_FICHA.tentarDeNovo}</Link>
            </Button>
          }
        >
          {MENSAGENS_FICHA.naFila}
        </StatusMessage>
      ) : fila.length === 0 ? (
        <EmptyState
          titulo={MENSAGENS_FICHA.filaVazia}
          descricao={MENSAGENS_FICHA.filaVaziaDescricao}
        />
      ) : (
        <ul className="flex flex-col border-y border-rule" data-slot="fila-de-fichas">
          {fila.map((f) => (
            <Linha key={f.slug} f={f} />
          ))}
        </ul>
      )}
    </div>
  );
}
