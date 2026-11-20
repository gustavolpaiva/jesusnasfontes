"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SkeletonBlock } from "@/components/estado/skeleton-block";
import { StatusMessage } from "@/components/estado/status-message";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { OuvirControl } from "@/modules/audio/ouvir-control";

// Bloco "Leitura" do Estudo (TRIL-02): a referência por extenso, o texto lido do banco com o número de
// cada versículo em `sup`, subtítulo por capítulo quando a Passagem passa de um capítulo, a nota dos
// versículos que a edição traz dentro de outro e o crédito. O texto chega pronto do servidor; nada
// aqui o reescreve. Os dados são simples de propósito (nomes e referências já formatados no servidor),
// para este arquivo, que roda no navegador, não puxar a tabela dos 66 livros.

export type PassagemParaTela = {
  /**
   * O texto bíblico já em trechos para a voz (sem números de versículo, « » nem marcas de nota),
   * montado no servidor com a referência falada: este arquivo roda no navegador e não leva a tabela
   * dos 66 livros.
   */
  trechosParaOuvir: string[];
  /** Nome da edição, como o crédito a escreve ("texto crítico, Nestle 1904"). */
  edicao: string;
  trechos: {
    /** Referência por extenso ("Mateus 3:13 a 4:11"). */
    referencia: string;
    capitulos: {
      /** Subtítulo ("Mateus 4"): só quando a Passagem passa de um capítulo. */
      subtitulo: string | null;
      versiculos: { chave: number; numero: number; conteudo: string }[];
    }[];
    /** Números dos versículos que a edição traz dentro do anterior (Marcos 5:19, dentro do 5:18). */
    mesclados: number[];
  }[];
};

type Props = {
  passagem: PassagemParaTela;
  /** Id do início do corpo do Estudo, para o link de salto. */
  idDoEstudo: string;
};

export function PassagemBiblica({ passagem, idDoEstudo }: Props) {
  const [aberto, setAberto] = useState(true);
  return (
    <section aria-labelledby="leitura-titulo" className="flex flex-col gap-4">
      <h2 id="leitura-titulo" className="text-label text-ink-muted">
        Leitura
      </h2>
      <Collapsible open={aberto} onOpenChange={setAberto} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <OuvirControl
            id="texto"
            trechos={passagem.trechosParaOuvir}
            nome="Ouvir o texto bíblico"
            rotulo="Ouvir o texto"
            meta="Lendo o texto bíblico"
            larguraDoBotao="min-w-[10.5rem]"
          />
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="-ml-4" aria-expanded={aberto}>
              {aberto ? "Recolher o texto" : "Mostrar o texto"}
              <ChevronDown
                aria-hidden="true"
                strokeWidth={1.5}
                className={aberto ? "rotate-180 transition-transform" : "transition-transform"}
              />
            </Button>
          </CollapsibleTrigger>
          <a
            href={`#${idDoEstudo}`}
            className="text-ui inline-flex min-h-11 items-center underline underline-offset-[3px]"
          >
            Ir para o Estudo
          </a>
        </div>
        <CollapsibleContent className="flex flex-col gap-5">
          {passagem.trechos.map((trecho, indice) => (
            // A mesma referência pode abrir dois trechos (vários intervalos): o índice desfaz o empate.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordem fixa da Passagem
            <div key={`${indice}-${trecho.referencia}`} className="flex flex-col gap-3">
              <h3 className="text-heading">{trecho.referencia}</h3>
              {trecho.capitulos.map((capitulo) => (
                <div key={capitulo.versiculos[0]?.chave} className="flex flex-col gap-2">
                  {capitulo.subtitulo ? (
                    <h4 className="text-label text-ink-muted">{capitulo.subtitulo}</h4>
                  ) : null}
                  <p className="text-leitura">
                    {capitulo.versiculos.map((v) => (
                      <span key={v.chave} data-versiculo={v.chave}>
                        <sup className="mr-1 text-[0.7em] text-ink-muted select-none">
                          {v.numero}
                        </sup>
                        <span data-texto>{v.conteudo}</span>{" "}
                      </span>
                    ))}
                  </p>
                </div>
              ))}
              {trecho.mesclados.map((numero) => (
                <p key={numero} className="text-meta text-ink-muted">
                  Nesta edição, o versículo {numero} está junto do {numero - 1}.
                </p>
              ))}
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <p className="text-meta text-ink-muted">
              Bíblia Livre ({passagem.edicao}), Creative Commons Atribuição 3.0 Brasil. Os sinais «
              » marcam partes ausentes dos manuscritos mais antigos.
            </p>
            {/* Em bloco próprio: um link de 44 px dentro da frase abriria um vão entre as linhas dela. */}
            <Link
              href="/creditos"
              className="text-meta inline-flex min-h-11 items-center self-start underline"
            >
              Créditos
            </Link>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** Enquanto o texto chega: três barras e o aviso para o leitor de tela. */
export function PassagemCarregando() {
  return (
    <section aria-labelledby="leitura-carregando" className="flex flex-col gap-4">
      <h2 id="leitura-carregando" className="text-label text-ink-muted">
        Leitura
      </h2>
      <SkeletonBlock barrasDeCorpo={3} rotulo="Carregando o texto…" />
    </section>
  );
}

/** O texto não veio: erro no próprio bloco, com a ação de tentar de novo (recarrega a página). */
export function PassagemErro() {
  const roteador = useRouter();
  const [pendente, iniciar] = useTransition();
  return (
    <section aria-labelledby="leitura-erro" className="flex flex-col gap-4">
      <h2 id="leitura-erro" className="text-label text-ink-muted">
        Leitura
      </h2>
      <StatusMessage
        tipo="erro"
        acao={
          <Button
            variant="secondary"
            pendente={pendente}
            rotuloPendente="Tentando…"
            onClick={() => iniciar(() => roteador.refresh())}
          >
            Tentar de novo
          </Button>
        }
      >
        Não foi possível carregar o texto bíblico agora. Tente de novo.
      </StatusMessage>
    </section>
  );
}
