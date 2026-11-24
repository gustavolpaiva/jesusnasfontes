import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { EmptyState } from "@/components/estado/empty-state";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { lerPainelDeGraus, type PainelDeGraus } from "@/modules/acervo/consultas-graus";
import { FILTROS, type FiltroDeGraus, lerFiltro } from "@/modules/acervo/estado-da-proposta";
import { lerLimite, MENSAGENS_GRAUS, POR_VEZ, textoDaMeta } from "@/modules/acervo/painel-graus";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { ListaGraus } from "./lista-graus";

// A lista de propostas de Grau (ACER-06, ACER-10, D-04; UI-SPEC tela 13). O agente propõe, o dono julga: aqui ele lê a
// frase, a justificativa e as Citações, e aprova (ou corrige) o Grau com um clique. Sem "rejeitar" e sem lote. O painel
// inteiro (meta, contagens e lista) vem de UMA leitura em instantâneo único.
export const dynamic = "force-dynamic";
export const metadata = { title: "Graus propostos" };

const BASE = "/admin/acervo/graus";

const ROTULO_DO_FILTRO: Record<FiltroDeGraus, string> = {
  pendentes: "Pendentes",
  aprovadas: "Aprovadas",
  todas: "Todas",
};

const hrefDoFiltro = (f: FiltroDeGraus) => (f === "pendentes" ? BASE : `${BASE}?filtro=${f}`);

function Filtros({ painel }: { painel: PainelDeGraus }) {
  return (
    <nav aria-label="Filtro das propostas" data-slot="filtro-graus">
      <ul className="flex flex-wrap gap-2">
        {FILTROS.map((f) => {
          const ativo = painel.filtro === f;
          return (
            <li key={f} className="flex">
              <Link
                href={hrefDoFiltro(f)}
                aria-current={ativo ? "true" : undefined}
                data-slot="filtro-graus-item"
                className={`text-ui inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 py-1 no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  ativo
                    ? "border-ink bg-ink text-paper"
                    : "border-rule-strong text-ink hover:bg-paper-soft"
                }`}
              >
                {ROTULO_DO_FILTRO[f]} ({painel.contagens[f]})
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default async function PaginaDeGraus({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string | string[]; ate?: string | string[] }>;
}) {
  const sessao = await exigirAdmin();
  const { filtro: filtroBruto, ate: ateBruto } = await searchParams;
  const filtro = lerFiltro(filtroBruto);
  const ate = lerLimite(ateBruto);

  let painel: PainelDeGraus | null = null;
  try {
    painel = await lerPainelDeGraus(sessao.sessao.id, filtro, ate);
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-graus-propostos", erro);
  }

  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-display">{MENSAGENS_GRAUS.titulo}</h1>
        <p className="text-leitura">{MENSAGENS_GRAUS.lede}</p>
        {painel ? (
          <p className="text-meta text-ink-muted" data-slot="meta-dos-graus">
            {textoDaMeta(painel.meta.aprovadas, painel.meta.total)}
          </p>
        ) : null}
      </div>
      {painel === null ? (
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <Link href={hrefDoFiltro(filtro)}>{MENSAGENS_GRAUS.tentarDeNovo}</Link>
            </Button>
          }
        >
          {MENSAGENS_GRAUS.erroDeCarga}
        </StatusMessage>
      ) : (
        <>
          <Filtros painel={painel} />
          {painel.propostas.length === 0 ? (
            filtro === "aprovadas" ? (
              <EmptyState
                titulo={MENSAGENS_GRAUS.vazioAprovadas}
                descricao={MENSAGENS_GRAUS.vazioAprovadasDescricao}
              />
            ) : (
              <EmptyState
                titulo={MENSAGENS_GRAUS.vazio}
                descricao={MENSAGENS_GRAUS.vazioDescricao}
              />
            )
          ) : (
            <>
              {/* O acordeão abre com `h3`: sem este `h2` a ordem dos títulos pularia um nível depois do `h1`. */}
              <h2 className="sr-only">Propostas</h2>
              <ListaGraus propostas={painel.propostas} />
              {painel.restantes > 0 ? (
                <div>
                  <Button asChild variant="secondary">
                    <Link
                      href={`${BASE}?${new URLSearchParams({ filtro, ate: String(ate + POR_VEZ) })}`}
                      scroll={false}
                      data-slot="mais-propostas"
                    >
                      {MENSAGENS_GRAUS.maisPropostas}
                    </Link>
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
