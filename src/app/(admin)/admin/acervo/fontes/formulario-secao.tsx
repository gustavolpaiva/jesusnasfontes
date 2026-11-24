"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { mensagemDaFalha } from "@/app/(admin)/admin/convites/mensagens";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { salvarResumoDeSecao } from "@/modules/acervo/acoes-fonte";
import { MENSAGENS } from "@/modules/acervo/schemas-painel";

// Resumo e palavras-chave em português de UMA seção (D-18). O rótulo "escrito por IA, não é tradução nem foi revisado"
// fica sempre visível ao lado dos campos: sem ele o resumo passaria por revisado.

type Props = {
  slug: string;
  secao: string;
  resumoInicial: string;
  palavrasIniciais: string[];
  /** A revisão da Fonte que a página leu; o banco recusa a escrita sobre uma que já não é a atual. */
  revisaoInicial: number;
};

export function FormularioSecao({
  slug,
  secao,
  resumoInicial,
  palavrasIniciais,
  revisaoInicial,
}: Props) {
  const router = useRouter();
  const mensagem = useRef<HTMLDivElement>(null);
  const [resumo, setResumo] = useState(resumoInicial);
  const [palavras, setPalavras] = useState(palavrasIniciais.join(", "));
  const [revisao, setRevisao] = useState(revisaoInicial);
  const [erro, setErro] = useState<string | null>(null);
  const [salva, setSalva] = useState(false);
  const [pendente, setPendente] = useState(false);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    if (versao > 0) mensagem.current?.focus();
  }, [versao]);

  async function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setPendente(true);
    setSalva(false);
    try {
      const r = await salvarResumoDeSecao({
        slug,
        secao,
        resumo_pt: resumo,
        palavras_chave_pt: palavras,
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

  return (
    <form onSubmit={aoEnviar} noValidate className="flex flex-col gap-6">
      <p className="text-meta text-ink-muted" data-slot="rotulo-resumo-auxiliar">
        Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado.
      </p>
      <Field>
        <FieldLabel htmlFor="campo-resumo_pt">Resumo em português</FieldLabel>
        <Textarea
          id="campo-resumo_pt"
          name="resumo_pt"
          value={resumo}
          onChange={(e) => setResumo(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="campo-palavras_chave_pt">Palavras-chave em português</FieldLabel>
        <Input
          id="campo-palavras_chave_pt"
          name="palavras_chave_pt"
          value={palavras}
          onChange={(e) => setPalavras(e.target.value)}
          autoComplete="off"
          aria-describedby="ajuda-palavras"
        />
        <FieldDescription>
          <span id="ajuda-palavras">Separadas por vírgula.</span>
        </FieldDescription>
      </Field>
      <div
        ref={mensagem}
        tabIndex={-1}
        className="flex flex-col gap-4 outline-none"
        aria-live="polite"
      >
        {erro ? <StatusMessage tipo="erro">{erro}</StatusMessage> : null}
        {salva && !erro ? <StatusMessage tipo="sucesso">Resumo salvo.</StatusMessage> : null}
      </div>
      <Button
        type="submit"
        variant="primary"
        className="w-full md:w-auto md:self-start"
        pendente={pendente}
        rotuloPendente="Salvando…"
      >
        Salvar resumo
      </Button>
    </form>
  );
}
