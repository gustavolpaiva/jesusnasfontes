"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { mensagemDaFalha } from "@/app/(admin)/admin/convites/mensagens";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { salvarFonte } from "@/modules/acervo/acoes-fonte";
import type { FonteDoPainel } from "@/modules/acervo/consultas-admin";
import { CODIGOS_FIXOS_DE_LICENCA } from "@/modules/acervo/licenca-exibida";
import { NIVEIS_NA_ORDEM, NOME_DO_NIVEL } from "@/modules/acervo/niveis";
import { MENSAGENS, type ResultadoDeSalvar } from "@/modules/acervo/schemas-painel";

// Formulário de Fonte DO PAINEL (incluir e editar), UI-SPEC tela 11: uma coluna, um `Field` por campo, grupos com título
// em Rótulo. Nada aqui decide ACER-09: o banco recusa e este formulário só mostra a mensagem do contrato no campo, com o
// foco movido para ele. "Salvar Fonte" nunca é desabilitado (só troca o rótulo enquanto salva). O texto digitado fica
// no formulário em qualquer erro. A Fonte que vem do arquivo usa outro formulário (`formulario-fonte-do-arquivo.tsx`).

type SecaoEmEdicao = {
  slug?: string;
  titulo: string;
  texto: string;
  resumo_pt: string;
  palavras_chave_pt: string;
};

type Estado = {
  titulo: string;
  autor: string;
  epoca: string;
  nivel: "primaria" | "academica" | "confessional";
  tradicao: string;
  idioma: "pt" | "en";
  tipo_texto: "integral" | "ficha";
  obra_protegida: boolean;
  origem_nome: string;
  origem_url: string;
  licenca: string;
  licenca_url: string;
  tradutor: string;
  traducao_ano: string;
  edicao: string;
  traduzida_por_nos: boolean;
  limites_pt: string;
  publicada: boolean;
  secoes: SecaoEmEdicao[];
};

function estadoInicial(f?: FonteDoPainel): Estado {
  return {
    titulo: f?.titulo ?? "",
    autor: f?.autor ?? "",
    epoca: f?.epoca ?? "",
    nivel: f?.nivel ?? "primaria",
    tradicao: f?.tradicao ?? "",
    idioma: f?.idioma ?? "pt",
    tipo_texto: f?.tipoTexto ?? "integral",
    obra_protegida: f?.obraProtegida ?? false,
    origem_nome: f?.origemNome ?? "",
    origem_url: f?.origemUrl ?? "",
    licenca: f?.licenca ?? "",
    licenca_url: f?.licencaUrl ?? "",
    tradutor: f?.tradutor ?? "",
    traducao_ano: f?.traducaoAno == null ? "" : String(f.traducaoAno),
    edicao: f?.edicao ?? "",
    traduzida_por_nos: f?.traduzidaPorNos ?? false,
    limites_pt: f?.limitesPt ?? "",
    publicada: f?.publicada ?? false,
    secoes: (f?.secoes ?? []).map((s) => ({
      slug: s.slug,
      titulo: s.titulo ?? "",
      texto: s.texto,
      resumo_pt: s.resumoPt ?? "",
      palavras_chave_pt: s.palavrasChavePt.join(", "),
    })),
  };
}

type Erros = Record<string, string>;

function ErroDoCampo({ id, erros }: { id: string; erros: Erros }) {
  if (!erros[id]) return null;
  return (
    <div id={`erro-${id}`}>
      <FieldError>{erros[id]}</FieldError>
    </div>
  );
}

function Opcao({ id, valor, children }: { id: string; valor: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <RadioGroupItem value={valor} id={id} />
      <Label htmlFor={id} className="text-ui">
        {children}
      </Label>
    </div>
  );
}

export function FormularioFonte({ fonte }: { fonte?: FonteDoPainel }) {
  const router = useRouter();
  const editando = fonte !== undefined;
  const formulario = useRef<HTMLFormElement>(null);
  const [estado, setEstado] = useState<Estado>(() => estadoInicial(fonte));
  const [erros, setErros] = useState<Erros>({});
  const [geral, setGeral] = useState<string | null>(null);
  const [salva, setSalva] = useState(false);
  const [pendente, setPendente] = useState(false);
  const [versaoDosErros, setVersaoDosErros] = useState(0);

  const mudar = <K extends keyof Estado>(campo: K, valor: Estado[K]) =>
    setEstado((e) => ({ ...e, [campo]: valor }));
  const mudarSecao = (i: number, parte: Partial<SecaoEmEdicao>) =>
    setEstado((e) => ({
      ...e,
      secoes: e.secoes.map((s, j) => (j === i ? { ...s, ...parte } : s)),
    }));

  // O envio com erro move o foco para o primeiro campo inválido, na ordem do formulário.
  useEffect(() => {
    if (versaoDosErros === 0) return;
    const primeiro = formulario.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (primeiro) primeiro.focus();
    else document.getElementById("mensagem-fonte")?.focus();
  }, [versaoDosErros]);

  async function aoEnviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setPendente(true);
    setSalva(false);
    try {
      const { secoes, ...resto } = estado;
      const resultado: ResultadoDeSalvar = await salvarFonte({
        ...resto,
        modo: editando ? "editar" : "criar",
        ...(editando ? { slug: fonte.slug } : {}),
        secoes: resto.tipo_texto === "integral" && podeTerSecoes(estado) ? secoes : [],
      });
      if (resultado.ok) {
        setErros({});
        setGeral(null);
        if (editando) {
          setSalva(true);
          router.refresh();
        } else {
          router.replace(`/admin/acervo/fontes/${resultado.slug}?salvo=1`);
        }
        return;
      }
      setErros(resultado.erros);
      setGeral(resultado.geral ?? null);
      setVersaoDosErros((v) => v + 1);
    } catch (erro) {
      const falha = mensagemDaFalha(erro, typeof navigator === "undefined" || navigator.onLine);
      if (!falha) throw erro;
      setErros({});
      setGeral(falha.texto.startsWith("Sem conexão") ? falha.texto : MENSAGENS.servidor);
      setVersaoDosErros((v) => v + 1);
    } finally {
      setPendente(false);
    }
  }

  const erroDe = (id: string) => erros[id];
  const invalido = (id: string) => (erroDe(id) ? true : undefined);
  const descrito = (id: string) => (erroDe(id) ? `erro-${id}` : undefined);
  const texto = (
    id: string,
    rotulo: string,
    valor: string,
    aoMudar: (v: string) => void,
    extra: { ajuda?: ReactNode; inputMode?: "numeric" | "url"; tipo?: string } = {},
  ) => (
    <Field>
      <FieldLabel htmlFor={`campo-${id}`}>{rotulo}</FieldLabel>
      <Input
        id={`campo-${id}`}
        name={id}
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        inputMode={extra.inputMode}
        type={extra.tipo}
        aria-invalid={invalido(id)}
        aria-describedby={descrito(id)}
        className="[overflow-wrap:anywhere]"
      />
      {extra.ajuda ? <FieldDescription>{extra.ajuda}</FieldDescription> : null}
      <ErroDoCampo id={id} erros={erros} />
    </Field>
  );

  const secoesVisiveis = estado.tipo_texto === "integral" && podeTerSecoes(estado);

  return (
    <form ref={formulario} onSubmit={aoEnviar} noValidate className="flex flex-col gap-8">
      <FieldSet>
        <FieldLegend>Identificação</FieldLegend>
        <FieldGroup>
          {texto("titulo", "Título", estado.titulo, (v) => mudar("titulo", v))}
          {texto("autor", "Autor", estado.autor, (v) => mudar("autor", v))}
          {texto("epoca", "Época (como aparece na tela)", estado.epoca, (v) => mudar("epoca", v))}
          <Field>
            <FieldLabel id="rotulo-nivel">Nível de fonte</FieldLabel>
            <RadioGroup
              value={estado.nivel}
              onValueChange={(v) => mudar("nivel", v as Estado["nivel"])}
              aria-labelledby="rotulo-nivel"
              name="nivel"
            >
              {NIVEIS_NA_ORDEM.map((n) => (
                <Opcao key={n} id={`campo-nivel-${n}`} valor={n}>
                  {NOME_DO_NIVEL[n]}
                </Opcao>
              ))}
            </RadioGroup>
          </Field>
          {estado.nivel === "confessional"
            ? texto("tradicao", "Tradição", estado.tradicao, (v) => mudar("tradicao", v), {
                ajuda: "A leitura confessional sempre nomeia a tradição que a escreveu.",
              })
            : null}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Texto</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel id="rotulo-idioma">Idioma do texto</FieldLabel>
            <RadioGroup
              value={estado.idioma}
              onValueChange={(v) => mudar("idioma", v as Estado["idioma"])}
              aria-labelledby="rotulo-idioma"
              name="idioma"
            >
              <Opcao id="campo-idioma-pt" valor="pt">
                Português
              </Opcao>
              <Opcao id="campo-idioma-en" valor="en">
                Inglês
              </Opcao>
            </RadioGroup>
          </Field>
          <Field>
            <FieldLabel id="rotulo-tipo">Tipo</FieldLabel>
            <RadioGroup
              value={estado.tipo_texto}
              onValueChange={(v) => mudar("tipo_texto", v as Estado["tipo_texto"])}
              aria-labelledby="rotulo-tipo"
              name="tipo_texto"
            >
              <Opcao id="campo-tipo-integral" valor="integral">
                Texto integral
              </Opcao>
              <Opcao id="campo-tipo-ficha" valor="ficha">
                Ficha
              </Opcao>
            </RadioGroup>
            {estado.tipo_texto === "ficha" ? (
              <FieldDescription>
                A Fonte de tipo Ficha guarda só a casca, sem texto. A ficha de verdade entra pelo
                arquivo de rascunhos e só aparece depois de verificada.
              </FieldDescription>
            ) : null}
          </Field>
          <Field>
            <div className="flex items-center gap-1">
              <Checkbox
                id="campo-obra_protegida"
                checked={estado.obra_protegida}
                onCheckedChange={(v) => mudar("obra_protegida", v === true)}
                aria-invalid={invalido("obra_protegida")}
                aria-describedby={["ajuda-obra_protegida", descrito("obra_protegida")]
                  .filter(Boolean)
                  .join(" ")}
              />
              <Label htmlFor="campo-obra_protegida" className="text-ui">
                Obra protegida
              </Label>
            </div>
            <FieldDescription>
              <span id="ajuda-obra_protegida">
                Marque quando a obra tem direitos autorais. Obra protegida só pode ter ficha com
                citações curtas.
              </span>
            </FieldDescription>
            <ErroDoCampo id="obra_protegida" erros={erros} />
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Origem</FieldLegend>
        <FieldGroup>
          {texto("origem_nome", "Nome da origem", estado.origem_nome, (v) =>
            mudar("origem_nome", v),
          )}
          {texto(
            "origem_url",
            "Origem do texto (endereço https)",
            estado.origem_url,
            (v) => mudar("origem_url", v),
            {
              inputMode: "url",
            },
          )}
          {texto("licenca", "Licença (código)", estado.licenca, (v) => mudar("licenca", v), {
            ajuda: (
              <>
                Códigos aceitos: {CODIGOS_FIXOS_DE_LICENCA.join(", ")} ou aberta-&lt;código&gt;,
                como aberta-cc-by-4.0.
              </>
            ),
          })}
          {texto(
            "licenca_url",
            "Endereço da licença",
            estado.licenca_url,
            (v) => mudar("licenca_url", v),
            {
              inputMode: "url",
            },
          )}
          {texto("tradutor", "Tradutor", estado.tradutor, (v) => mudar("tradutor", v))}
          {texto(
            "traducao_ano",
            "Ano da tradução",
            estado.traducao_ano,
            (v) => mudar("traducao_ano", v),
            {
              inputMode: "numeric",
            },
          )}
          {texto("edicao", "Edição", estado.edicao, (v) => mudar("edicao", v))}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Tradução</FieldLegend>
        <Field>
          <div className="flex items-center gap-1">
            <Checkbox
              id="campo-traduzida_por_nos"
              checked={estado.traduzida_por_nos}
              onCheckedChange={(v) => mudar("traduzida_por_nos", v === true)}
            />
            <Label htmlFor="campo-traduzida_por_nos" className="text-ui">
              Tradução feita por nós
            </Label>
          </div>
          <FieldDescription>
            Ao marcar, o aviso de tradução passa a aparecer na Fonte.
          </FieldDescription>
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Limites</FieldLegend>
        <Field>
          <FieldLabel htmlFor="campo-limites_pt">O que esta Fonte não pode dizer</FieldLabel>
          <Textarea
            id="campo-limites_pt"
            name="limites_pt"
            value={estado.limites_pt}
            onChange={(e) => mudar("limites_pt", e.target.value)}
            aria-invalid={invalido("limites_pt")}
            aria-describedby={descrito("limites_pt")}
          />
          <FieldDescription>Data, viés e transmissão do texto.</FieldDescription>
          <ErroDoCampo id="limites_pt" erros={erros} />
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Seções</FieldLegend>
        {secoesVisiveis ? (
          <div className="flex flex-col gap-6">
            {estado.secoes.map((s, i) => (
              <SecaoDoFormulario
                // A chave é a posição: a seção nova ainda não tem endereço.
                // biome-ignore lint/suspicious/noArrayIndexKey: seções não se reordenam nem se removem depois de salvas
                key={i}
                i={i}
                secao={s}
                mudar={(parte) => mudarSecao(i, parte)}
                erros={erros}
                aoRemover={
                  s.slug === undefined
                    ? () => setEstado((e) => ({ ...e, secoes: e.secoes.filter((_, j) => j !== i) }))
                    : undefined
                }
              />
            ))}
            <ErroDoCampo id="secoes" erros={erros} />
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              onClick={() =>
                setEstado((e) => ({
                  ...e,
                  secoes: [
                    ...e.secoes,
                    { titulo: "", texto: "", resumo_pt: "", palavras_chave_pt: "" },
                  ],
                }))
              }
            >
              Adicionar seção
            </Button>
          </div>
        ) : (
          <p className="text-meta text-ink-muted">
            As seções aparecem quando o tipo é Texto integral e a licença e o endereço da origem
            estão preenchidos.
          </p>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend>Publicação</FieldLegend>
        <Field>
          <div className="flex items-center gap-1">
            <Checkbox
              id="campo-publicada"
              checked={estado.publicada}
              onCheckedChange={(v) => mudar("publicada", v === true)}
              disabled={estado.tipo_texto === "ficha"}
              aria-describedby="ajuda-publicada"
            />
            <Label htmlFor="campo-publicada" className="text-ui">
              Publicada
            </Label>
          </div>
          <FieldDescription>
            <span id="ajuda-publicada">
              {estado.tipo_texto === "ficha"
                ? "Uma ficha fica visível quando é verificada, não por este campo."
                : "Visível para todos os Estudantes."}
            </span>
          </FieldDescription>
        </Field>
      </FieldSet>

      <div
        id="mensagem-fonte"
        tabIndex={-1}
        className="flex flex-col gap-4 outline-none"
        aria-live="polite"
      >
        {geral ? <StatusMessage tipo="erro">{geral}</StatusMessage> : null}
        {salva && !geral ? <StatusMessage tipo="sucesso">{MENSAGENS.salva}</StatusMessage> : null}
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

/** As seções só têm sentido num texto integral com licença e origem preenchidas (UI-SPEC). */
function podeTerSecoes(e: Estado): boolean {
  return e.licenca.trim() !== "" && e.origem_url.trim() !== "";
}

function SecaoDoFormulario({
  i,
  secao,
  mudar,
  erros,
  aoRemover,
}: {
  i: number;
  secao: SecaoEmEdicao;
  mudar: (parte: Partial<SecaoEmEdicao>) => void;
  erros: Erros;
  aoRemover?: () => void;
}) {
  const id = (c: string) => `secoes-${i}-${c}`;
  const inv = (c: string) => (erros[id(c)] ? true : undefined);
  const desc = (c: string) => (erros[id(c)] ? `erro-${id(c)}` : undefined);
  return (
    <fieldset
      data-slot="secao-do-formulario"
      className="flex flex-col gap-4 border-t border-rule pt-4"
    >
      <legend className="text-label mb-2">{`Seção ${i + 1}`}</legend>
      <Field>
        <FieldLabel htmlFor={`campo-${id("titulo")}`}>Título</FieldLabel>
        <Input
          id={`campo-${id("titulo")}`}
          value={secao.titulo}
          onChange={(e) => mudar({ titulo: e.target.value })}
          autoComplete="off"
          aria-invalid={inv("titulo")}
          aria-describedby={desc("titulo")}
        />
        <ErroDoCampo id={id("titulo")} erros={erros} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`campo-${id("texto")}`}>
          Texto (parágrafos separados por uma linha em branco)
        </FieldLabel>
        <Textarea
          id={`campo-${id("texto")}`}
          value={secao.texto}
          onChange={(e) => mudar({ texto: e.target.value })}
          className="min-h-48"
          aria-invalid={inv("texto")}
          aria-describedby={desc("texto")}
        />
        <ErroDoCampo id={id("texto")} erros={erros} />
      </Field>
      <p className="text-meta text-ink-muted" data-slot="rotulo-resumo-auxiliar">
        Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado.
      </p>
      <Field>
        <FieldLabel htmlFor={`campo-${id("resumo_pt")}`}>Resumo em português</FieldLabel>
        <Textarea
          id={`campo-${id("resumo_pt")}`}
          value={secao.resumo_pt}
          onChange={(e) => mudar({ resumo_pt: e.target.value })}
          aria-invalid={inv("resumo_pt")}
          aria-describedby={desc("resumo_pt")}
        />
        <ErroDoCampo id={id("resumo_pt")} erros={erros} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`campo-${id("palavras_chave_pt")}`}>
          Palavras-chave em português
        </FieldLabel>
        <Input
          id={`campo-${id("palavras_chave_pt")}`}
          value={secao.palavras_chave_pt}
          onChange={(e) => mudar({ palavras_chave_pt: e.target.value })}
          autoComplete="off"
          aria-describedby={`ajuda-${id("palavras")}`}
        />
        <FieldDescription>
          <span id={`ajuda-${id("palavras")}`}>Separadas por vírgula.</span>
        </FieldDescription>
      </Field>
      {aoRemover ? (
        <Button type="button" variant="secondary" className="self-start" onClick={aoRemover}>
          Remover esta seção
        </Button>
      ) : null}
    </fieldset>
  );
}
