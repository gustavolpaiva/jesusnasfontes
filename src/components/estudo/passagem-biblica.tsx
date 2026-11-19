import Link from "next/link";
import { decompor, formatarReferencia, LIVROS } from "@/modules/referencias";
import type { Passagem } from "@/modules/texto";

// Bloco "Leitura" do Estudo: a referência por extenso, o texto lido do banco com o número de cada
// versículo em `sup`, subtítulo por capítulo quando a Passagem passa de um capítulo, a nota dos
// versículos que a edição traz dentro de outro e o crédito. O texto vem inteiro de `lerPassagem`;
// nada aqui o reescreve.

const NOME_DA_EDICAO: Record<string, string> = {
  n4: "texto crítico, Nestle 1904",
  tr: "Textus Receptus",
};

type Props = {
  referencias: readonly string[];
  passagem: Passagem;
};

const nomeDoLivro = (numero: number) => LIVROS.find((l) => l.numero === numero)?.nome ?? "";

export function PassagemBiblica({ referencias, passagem }: Props) {
  const edicao = NOME_DA_EDICAO[passagem.edicao] ?? passagem.edicao;
  return (
    <section aria-labelledby="leitura-titulo" className="flex flex-col gap-5">
      <h2 id="leitura-titulo" className="text-label text-ink-muted">
        Leitura
      </h2>
      {passagem.trechos.map((trecho, indice) => (
        <div key={trecho.inicio} className="flex flex-col gap-3">
          <h3 className="text-heading">{formatarReferencia(referencias[indice] ?? "")}</h3>
          {trecho.capitulos.map((capitulo) => (
            <div key={`${capitulo.livro}-${capitulo.capitulo}`} className="flex flex-col gap-2">
              {trecho.capitulos.length > 1 ? (
                <h4 className="text-label text-ink-muted">
                  {nomeDoLivro(capitulo.livro)} {capitulo.capitulo}
                </h4>
              ) : null}
              <p className="text-leitura">
                {capitulo.versiculos.map((v) => (
                  <span key={v.chave} data-versiculo={v.chave}>
                    <sup className="mr-1 text-[0.7em] text-ink-muted select-none">{v.numero}</sup>
                    <span data-texto>{v.conteudo}</span>{" "}
                  </span>
                ))}
              </p>
            </div>
          ))}
          {trecho.mesclados.map((m) => {
            const numero = decompor(m.chave).versiculo;
            return (
              <p key={m.chave} className="text-meta text-ink-muted">
                Nesta edição, o versículo {numero} está junto do {numero - 1}.
              </p>
            );
          })}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <p className="text-meta text-ink-muted">
          Bíblia Livre ({edicao}), Creative Commons Atribuição 3.0 Brasil. Os sinais « » marcam
          partes ausentes dos manuscritos mais antigos.
        </p>
        {/* Em bloco próprio: um link de 44 px dentro da frase abriria um vão entre as linhas dela. */}
        <Link
          href="/creditos"
          className="text-meta inline-flex min-h-11 items-center self-start underline"
        >
          Créditos
        </Link>
      </div>
    </section>
  );
}
