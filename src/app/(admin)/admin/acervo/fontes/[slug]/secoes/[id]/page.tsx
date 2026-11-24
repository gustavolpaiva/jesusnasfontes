import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { registrarErro } from "@/lib/registro";
import { type FonteDoPainel, lerFonteDoPainel } from "@/modules/acervo/consultas-admin";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { FormularioSecao } from "../../../formulario-secao";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resumo da seção" };

const BASE = "/admin/acervo/fontes";

// Só o resumo e as palavras-chave de UMA seção (o texto nunca se edita aqui). `[id]` é o endereço da seção dentro da
// Fonte (`18` em `josefo-antiguidades/18`).
export default async function PaginaResumoDaSecao({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  await exigirAdmin();
  const { slug, id } = await params;

  let fonte: FonteDoPainel | null;
  try {
    fonte = await lerFonteDoPainel(slug);
  } catch (erro) {
    unstable_rethrow(erro);
    registrarErro("admin-resumo-da-secao", erro);
    return (
      <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
        <h1 className="text-display">Resumo da seção</h1>
        <StatusMessage tipo="erro">Não conseguimos carregar a seção. Tente de novo.</StatusMessage>
      </div>
    );
  }
  const secao = fonte?.secoes.find((s) => s.slug === id);
  if (!fonte || !secao || fonte.tipoTexto === "ficha") notFound();

  return (
    <div className="mx-auto flex w-full max-w-[var(--largura-ampla)] flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href={`${BASE}/${fonte.slug}`}>Voltar à Fonte</Link>
      </Button>
      <h1 className="text-display [overflow-wrap:anywhere]">{secao.titulo ?? secao.slug}</h1>
      <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">{fonte.titulo}</p>
      <FormularioSecao
        slug={fonte.slug}
        secao={secao.slug}
        resumoInicial={secao.resumoPt ?? ""}
        palavrasIniciais={secao.palavrasChavePt}
        revisaoInicial={fonte.revisao}
      />
    </div>
  );
}
