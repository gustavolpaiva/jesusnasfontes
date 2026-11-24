import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { FonteLida } from "@/modules/acervo/consultas";
import { textoDaLicenca } from "@/modules/acervo/licenca-exibida";
import { NOME_DO_NIVEL } from "@/modules/acervo/niveis";

// De onde vem o texto de uma Fonte (ACER-04): Nível, origem, licença, tradução e idioma, sempre visíveis na
// página da Fonte. O endereço de origem é só EXIBIDO como link: o servidor nunca o requisita. Só endereço
// https vira link (o contrato e o banco já recusam outro; aqui é a segunda trava, na tela).

const IDIOMA = { pt: "Português", en: "Inglês" } as const;

function LinkDeFora({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https:\/\/\S+$/.test(href))
    return <span className="[overflow-wrap:anywhere]">{href}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1 text-rubric underline [overflow-wrap:anywhere]"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <ExternalLink aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />
      <span className="sr-only"> (abre fora do site)</span>
    </a>
  );
}

function Par({ termo, children }: { termo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-rule py-3 first:pt-0 last:border-b-0 last:pb-0">
      <dt className="text-label text-ink-muted">{termo}</dt>
      <dd className="text-ui flex min-w-0 flex-col items-start [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

export const TRADUTOR_NAO_IDENTIFICADO = "tradutor não identificado na edição";

export function BlocoProveniencia({ fonte }: { fonte: FonteLida["fonte"] }) {
  const traducao = { tradutor: fonte.tradutor, ano: fonte.traducaoAno };
  // O tradutor é só quem traduziu ESTA obra. Sem nome na origem, a página diz que não há (nunca inventa um) e o
  // editor do volume aparece à parte, em linha própria.
  const quemTraduziu = [
    fonte.tradutor,
    fonte.traducaoAno === null ? null : String(fonte.traducaoAno),
  ]
    .filter(Boolean)
    .join(", ");
  const semTradutor = !fonte.tradutor && !fonte.traduzidaPorNos;
  return (
    <dl
      id="origem"
      data-slot="bloco-proveniencia"
      className="flex scroll-mt-4 flex-col"
      aria-label="Proveniência do texto"
    >
      <Par termo="Nível de fonte">{NOME_DO_NIVEL[fonte.nivel]}</Par>
      {fonte.origemNome || fonte.origemUrl ? (
        <Par termo="Origem do texto">
          {fonte.origemNome ? <span>{fonte.origemNome}</span> : null}
          {fonte.origemUrl ? (
            <LinkDeFora href={fonte.origemUrl}>{fonte.origemUrl}</LinkDeFora>
          ) : null}
        </Par>
      ) : null}
      {fonte.licenca ? (
        <Par termo="Licença">
          <span>{textoDaLicenca(fonte.licenca, traducao)}</span>
          {fonte.licencaUrl ? (
            <LinkDeFora href={fonte.licencaUrl}>Texto da licença</LinkDeFora>
          ) : null}
        </Par>
      ) : null}
      <Par termo="Tradução">
        {fonte.traduzidaPorNos ? <span>Tradução feita por nós</span> : null}
        {quemTraduziu ? <span>{quemTraduziu}</span> : null}
        {semTradutor ? <span>{TRADUTOR_NAO_IDENTIFICADO}</span> : null}
        {fonte.edicao ? <span>{fonte.edicao}</span> : null}
      </Par>
      {fonte.editor ? <Par termo="Editor do volume">{fonte.editor}</Par> : null}
      <Par termo="Idioma do texto">{IDIOMA[fonte.idioma]}</Par>
    </dl>
  );
}
