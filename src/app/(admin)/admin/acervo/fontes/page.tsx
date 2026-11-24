import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { FiltroNivel } from "@/components/acervo/filtro-nivel";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type FonteNaLista, listarFontesDoPainel } from "@/modules/acervo/consultas-admin";
import { lerNivelDoParametro, NIVEIS_NA_ORDEM } from "@/modules/acervo/niveis";
import { exigirAdmin } from "@/modules/identidade/sessao";

// Lista de Fontes do painel (ACER-08, UI-SPEC tela 11): todas as Fontes, publicadas ou não, com o Nível, o estado e
// a origem do registro. O filtro por Nível usa os mesmos links do Acervo, e só oferece Nível que tem Fonte.
export const dynamic = "force-dynamic";
export const metadata = { title: "Fontes" };

const BASE = "/admin/acervo/fontes";

function contagem(n: number): string {
  return n === 0 ? "Nenhuma Fonte" : n === 1 ? "1 Fonte" : `${n} Fontes`;
}

function Linha({ f }: { f: FonteNaLista }) {
  return (
    <li
      data-slot="linha-fonte-admin"
      className="flex flex-col gap-2 border-b border-rule py-4 last:border-b-0"
    >
      <p className="text-ui font-semibold [overflow-wrap:anywhere]">{f.titulo}</p>
      <div className="flex flex-wrap items-center gap-2">
        <SeloNivel nivel={f.nivel} />
        {f.tipoTexto === "ficha" ? (
          <ChipEstado tom="pendente">Ficha</ChipEstado>
        ) : f.publicada ? (
          <ChipEstado tom="concluido">Publicada</ChipEstado>
        ) : (
          <ChipEstado tom="pendente">Não publicada</ChipEstado>
        )}
        {f.emConflito ? <ChipEstado tom="atencao">Em conflito com a carga</ChipEstado> : null}
        <span className="text-meta text-ink-muted">
          {f.origem === "arquivo" ? "do arquivo" : "do painel"}
        </span>
      </div>
      <Button asChild variant="secondary" className="self-start">
        <Link href={`${BASE}/${f.slug}`} aria-label={`Editar ${f.titulo}`}>
          Editar
        </Link>
      </Button>
    </li>
  );
}

export default async function PaginaDeFontes({
  searchParams,
}: {
  searchParams: Promise<{ nivel?: string | string[] }>;
}) {
  await exigirAdmin();
  const { nivel: bruto } = await searchParams;
  const pedido = lerNivelDoParametro(bruto);

  let fontes: FonteNaLista[] | null = null;
  try {
    fontes = await listarFontesDoPainel();
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-lista-de-fontes", erro);
  }

  const incluir = (
    <Button asChild variant="primary" className="self-start">
      <Link href={`${BASE}/novo`}>Incluir Fonte</Link>
    </Button>
  );

  if (fontes === null) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
        <h1 className="text-display">Fontes</h1>
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <Link href={BASE}>Tentar de novo</Link>
            </Button>
          }
        >
          Não conseguimos carregar as Fontes. Tente de novo.
        </StatusMessage>
      </div>
    );
  }

  const oferecidos = NIVEIS_NA_ORDEM.flatMap((nivel) => {
    const total = fontes.filter((f) => f.nivel === nivel).length;
    return total > 0 ? [{ nivel, total }] : [];
  });
  const aplicado = pedido && oferecidos.some((o) => o.nivel === pedido) ? pedido : null;
  const mostradas = aplicado ? fontes.filter((f) => f.nivel === aplicado) : fontes;

  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <h1 className="text-display">Fontes</h1>
      {incluir}
      {fontes.length === 0 ? (
        <EmptyState
          titulo="Nenhuma Fonte ainda"
          descricao="As Fontes do arquivo aparecem aqui depois da carga. Inclua a primeira pelo painel."
        />
      ) : (
        <>
          <FiltroNivel oferecidos={oferecidos} selecionado={aplicado} base={BASE} />
          <p className="text-meta text-ink-muted" aria-live="polite">
            {contagem(mostradas.length)}
          </p>
          <ul className="flex flex-col border-y border-rule">
            {mostradas.map((f) => (
              <Linha key={f.slug} f={f} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
