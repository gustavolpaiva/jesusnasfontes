"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { mensagemDaFalha } from "@/app/(admin)/admin/convites/mensagens";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { salvarFonteDoArquivo } from "@/modules/acervo/acoes-fonte";
import type { FonteDoPainel } from "@/modules/acervo/consultas-admin";
import { MENSAGENS } from "@/modules/acervo/schemas-painel";

// Fonte que veio do arquivo versionado: o painel só edita os limites e a publicação. O resto (título, autor, origem,
// licença e texto) é do arquivo e aparece só para leitura, com a explicação do contrato. O banco também recusa a
// edição desses campos (P0003); aqui o formulário nem os oferece.

const ROTULO_DO_IDIOMA = { pt: "Português", en: "Inglês" } as const;

export function FormularioFonteDoArquivo({
  fonte,
  salvaAgora,
}: {
  fonte: FonteDoPainel;
  salvaAgora: boolean;
}) {
  const router = useRouter();
  const mensagem = useRef<HTMLDivElement>(null);
  const [limites, setLimites] = useState(fonte.limitesPt ?? "");
  const [publicada, setPublicada] = useState(fonte.publicada);
  const [revisao, setRevisao] = useState(fonte.revisao);
  const [erro, setErro] = useState<string | null>(null);
  const [salva, setSalva] = useState(salvaAgora);
  const [pendente, setPendente] = useState(false);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    if (versao > 0) mensagem.current?.focus();
  }, [versao]);

  // O servidor mudou o valor por fora do formulário (a reversão ao arquivo): o campo acompanha o que está salvo.
  useEffect(() => {
    setLimites(fonte.limitesPt ?? "");
    setPublicada(fonte.publicada);
    setRevisao(fonte.revisao);
  }, [fonte.limitesPt, fonte.publicada, fonte.revisao]);

  async function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setPendente(true);
    setSalva(false);
    try {
      const r = await salvarFonteDoArquivo({
        slug: fonte.slug,
        limites_pt: limites,
        publicada,
        revisao,
      });
      if (r.ok) {
        setErro(null);
        setRevisao(r.revisao);
        setSalva(true);
        router.refresh();
      } else {
        setErro(r.geral ?? Object.values(r.erros)[0] ?? MENSAGENS.servidor);
      }
      setVersao((v) => v + 1);
    } catch (e) {
      const falha = mensagemDaFalha(e, typeof navigator === "undefined" || navigator.onLine);
      if (!falha) throw e;
      setErro(falha.texto.startsWith("Sem conexão") ? falha.texto : MENSAGENS.servidor);
      setVersao((v) => v + 1);
    } finally {
      setPendente(false);
    }
  }

  const leitura: [string, string | null][] = [
    ["Título", fonte.titulo],
    ["Autor", fonte.autor],
    ["Época", fonte.epoca],
    ["Idioma do texto", ROTULO_DO_IDIOMA[fonte.idioma]],
    ["Origem do texto", fonte.origemNome],
    ["Endereço da origem", fonte.origemUrl],
    ["Licença", fonte.licenca],
    ["Endereço da licença", fonte.licencaUrl],
    ["Tradutor", fonte.tradutor],
    ["Edição", fonte.edicao],
  ];

  return (
    <form onSubmit={aoEnviar} noValidate className="flex flex-col gap-8">
      <section aria-labelledby="titulo-do-arquivo" className="flex flex-col gap-3">
        <h2 id="titulo-do-arquivo" className="text-label text-ink-muted">
          Do arquivo
        </h2>
        <p className="text-leitura">
          Esta Fonte vem do arquivo versionado. O painel edita o resumo, as palavras-chave, os
          limites e a publicação.
        </p>
        <dl
          className="flex flex-col divide-y divide-rule border-y border-rule"
          data-slot="campos-do-arquivo"
        >
          {leitura
            .filter(([, v]) => v)
            .map(([rotulo, valor]) => (
              <div
                key={rotulo}
                className="flex flex-col gap-1 py-2 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4"
              >
                <dt className="text-meta text-ink-muted">{rotulo}</dt>
                <dd className="text-ui [overflow-wrap:anywhere]" style={{ hyphens: "none" }}>
                  {valor}
                </dd>
              </div>
            ))}
        </dl>
      </section>

      <Field>
        <FieldLabel htmlFor="campo-limites_pt">O que esta Fonte não pode dizer</FieldLabel>
        <Textarea
          id="campo-limites_pt"
          name="limites_pt"
          value={limites}
          onChange={(e) => setLimites(e.target.value)}
        />
        <FieldDescription>Data, viés e transmissão do texto.</FieldDescription>
      </Field>

      <Field>
        <div className="flex items-center gap-1">
          <Checkbox
            id="campo-publicada"
            checked={publicada}
            onCheckedChange={(v) => setPublicada(v === true)}
            aria-describedby="ajuda-publicada"
          />
          <Label htmlFor="campo-publicada" className="text-ui">
            Publicada
          </Label>
        </div>
        <FieldDescription>
          <span id="ajuda-publicada">Visível para todos os Estudantes.</span>
        </FieldDescription>
      </Field>

      <div
        ref={mensagem}
        tabIndex={-1}
        className="flex flex-col gap-4 outline-none"
        aria-live="polite"
      >
        {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
        {salva && !erro ? <StatusMessage tipo="sucesso">{MENSAGENS.salva}</StatusMessage> : null}
      </div>
      <Button
        type="submit"
        variant="primary"
        className="w-full md:w-auto md:self-start"
        pendente={pendente}
        rotuloPendente="Salvando…"
      >
        Salvar Fonte
      </Button>
    </form>
  );
}
