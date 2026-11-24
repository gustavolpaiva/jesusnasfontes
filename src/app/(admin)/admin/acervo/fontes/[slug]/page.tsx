import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { ChipEstado } from "@/components/acervo/chip-estado";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type FonteDoPainel, lerFonteDoPainel } from "@/modules/acervo/consultas-admin";
import { MENSAGENS } from "@/modules/acervo/schemas-painel";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { FormularioFonte } from "../formulario-fonte";
import { FormularioFonteDoArquivo } from "../formulario-fonte-do-arquivo";
import { AvisoDeConflito } from "../reverter-dialogo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editar Fonte" };

const BASE = "/admin/acervo/fontes";

export default async function PaginaEditarFonte({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ salvo?: string }>;
}) {
  // A guarda vem antes de tudo: quem não é Admin com segundo fator recebe a 404 (ou a tela do segundo fator).
  await exigirAdmin();
  const { slug } = await params;
  const { salvo } = await searchParams;

  let fonte: FonteDoPainel | null;
  try {
    fonte = await lerFonteDoPainel(slug);
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-editar-fonte", erro);
    return (
      <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
        <h1 className="text-display">Editar Fonte</h1>
        <StatusMessage
          tipo="erro"
          acao={
            <Button asChild variant="secondary">
              <Link href={`${BASE}/${slug}`}>Tentar de novo</Link>
            </Button>
          }
        >
          Não conseguimos carregar a Fonte. Tente de novo.
        </StatusMessage>
      </div>
    );
  }
  if (!fonte) notFound();

  const doArquivo = fonte.origem === "arquivo";
  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href={BASE}>Voltar às Fontes</Link>
      </Button>
      <h1 className="text-display [overflow-wrap:anywhere]">{fonte.titulo}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {fonte.tipoTexto === "ficha" ? (
          <ChipEstado tom="pendente">Ficha</ChipEstado>
        ) : fonte.publicada ? (
          <ChipEstado tom="concluido">Publicada</ChipEstado>
        ) : (
          <ChipEstado tom="pendente">Não publicada</ChipEstado>
        )}
        <span className="text-meta text-ink-muted">{doArquivo ? "do arquivo" : "do painel"}</span>
      </div>
      {fonte.conflito.length > 0 ? (
        <AvisoDeConflito slug={fonte.slug} campos={fonte.conflito} />
      ) : null}
      {salvo === "1" ? <StatusMessage tipo="sucesso">{MENSAGENS.salva}</StatusMessage> : null}

      {doArquivo && fonte.tipoTexto === "ficha" ? (
        <StatusMessage tipo="informacao">
          Esta Fonte é uma ficha do arquivo. Fichas não se editam neste painel: elas se verificam
          pela fila de fichas.
        </StatusMessage>
      ) : doArquivo ? (
        <>
          <FormularioFonteDoArquivo fonte={fonte} salvaAgora={false} />
          <section aria-labelledby="titulo-secoes" className="flex flex-col gap-3">
            <h2 id="titulo-secoes" className="text-label text-ink-muted">
              {`Seções (${fonte.secoes.length})`}
            </h2>
            <ul className="flex flex-col border-y border-rule">
              {fonte.secoes.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 border-b border-rule py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-ui [overflow-wrap:anywhere]">{s.titulo ?? s.slug}</span>
                    <span className="text-meta text-ink-muted">
                      {s.resumoPt ? "com resumo" : "sem resumo"}
                    </span>
                  </div>
                  <Button asChild variant="secondary" className="self-start">
                    <Link
                      href={`${BASE}/${fonte.slug}/secoes/${s.slug}`}
                      aria-label={`Editar resumo de ${s.titulo ?? s.slug}`}
                    >
                      Editar resumo
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <FormularioFonte fonte={fonte} />
      )}
    </div>
  );
}
