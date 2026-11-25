import Link from "next/link";
import { Fragment } from "react";
import { registrarErro } from "@/lib/registro";
import { slugsDasFontesPublicadas } from "@/modules/acervo/consultas";
import { type EntradaDeCredito, prepararCreditos } from "@/modules/creditos/creditos";

// Os registros são lidos uma vez, quando o módulo é carregado (no build, o `next build` carrega a
// página e um registro com campo faltando derruba o build). O que muda a cada requisição é só QUAIS Fontes estão
// publicadas no banco: o "Usado em" só oferece link para Fonte que o Estudante abre (o painel despublica sem passar pelo
// YAML, e o link viraria 404). Sem o banco, vale o estado do YAML e o erro é registrado: a atribuição nunca some.
//
// Sem `export const dynamic = "force-static"`: o layout raiz é dinâmico de propósito (o nonce da
// política de conteúdo muda a cada requisição, e o tema e o tamanho do texto vêm dos cookies). Com
// `force-static` a página saía sem nonce e sem ler os cookies: medido no e2e, o passo 5 do tamanho do
// texto virava o padrão em /creditos (UI-03).
export const dynamic = "force-dynamic";

const creditos = prepararCreditos();

async function entradasDaPagina(): Promise<EntradaDeCredito[]> {
  try {
    return creditos.montar(await slugsDasFontesPublicadas());
  } catch (erro) {
    registrarErro("creditos-fontes-publicadas", erro);
    return creditos.montar();
  }
}

export const metadata = { title: "Créditos" };

const rotulo = "text-label text-ink-muted";
// Link de endereço: EM LINHA, dentro dos parênteses da frase "Versão ou data (endereço)". Como bloco (`inline-block`),
// o endereço pulava para a linha de baixo inteiro e deixava o "(" sozinho no fim da linha anterior e o ")" sozinho na
// seguinte (medido em 1280, 390 e 320 px). Em linha ele acompanha a frase e quebra onde precisar; link de prosa fica
// isento dos 44 px (WCAG 2.5.8). `break-all` é o que faz um endereço longo quebrar dentro da coluna: medido no WebKit
// (projeto `celular`, 320 px, passo 5 do texto), `overflow-wrap: anywhere` sozinho NÃO quebra o endereço do repositório
// (452 px de texto numa caixa de 272 px, e a página ganhava 156 px de rolagem horizontal); `break-all` quebra no
// WebKit e no Chromium.
const linkDeEndereco = "break-all underline";

/**
 * O texto do endereço com o primeiro e o último caractere presos ao que vem ao lado (`nowrap`). Com `break-all`, o
 * WebKit aceita quebrar logo depois do "(" e logo antes do ")" e deixa o parêntese sozinho na ponta da linha (medido a
 * 320 px, passo 5, e reproduzido em página estática com a fonte de 16 a 28 px: 6 em 360 casos; com os dois caracteres
 * presos, 0 em 360, nos dois motores). Um caractere de junção de palavras (U+2060) NÃO resolve no WebKit. O texto, o
 * nome acessível e o que se acha por busca são os mesmos do endereço; o miolo continua quebrável em qualquer ponto.
 */
function EnderecoSemOrfao({ endereco }: { endereco: string }) {
  if (endereco.length < 3) return <>{endereco}</>;
  return (
    <>
      <span className="whitespace-nowrap">{endereco.slice(0, 1)}</span>
      {endereco.slice(1, -1)}
      <span className="whitespace-nowrap">{endereco.slice(-1)}</span>
    </>
  );
}

// Uma linha de autor entra como texto (as entradas da Fase 1); mais de uma, como lista sem marcador:
// cada autor ou papel em sua linha, legível em 320 px.
function Autores({ autores }: { autores: string[] }) {
  if (autores.length === 1) return <>{autores[0]}</>;
  return (
    <ul className="flex flex-col gap-1">
      {autores.map((autor) => (
        <li key={autor}>{autor}</li>
      ))}
    </ul>
  );
}

/**
 * Uma entrada de crédito, no molde da Fase 1: nome em Título, linhas em Corpo, rótulos em Rótulo.
 * `nivel` é o nível do título: 2 nas entradas gerais, 3 nas do Acervo (embaixo do título da seção).
 * Toda linha quebra em qualquer ponto (`overflow-wrap: anywhere`), sem estourar a coluna em 320 px.
 */
function Entrada({ entrada: e, nivel }: { entrada: EntradaDeCredito; nivel: 2 | 3 }) {
  const Titulo = nivel === 3 ? "h3" : "h2";
  // O nome de uma origem do Acervo pode ser longo (o registro traz o título inteiro do volume): quebra
  // em qualquer ponto. As entradas da Fase 1 saem com as classes de sempre, intactas.
  const titulo =
    nivel === 3
      ? "text-heading text-[1.5rem] leading-tight [overflow-wrap:anywhere]"
      : "text-heading text-[1.5rem] leading-tight";
  return (
    <li className="flex flex-col gap-4 py-6">
      <Titulo className={titulo}>{e.nome}</Titulo>
      {e.creditoLiteral ? (
        <p className="text-leitura border-l-2 border-rule-strong pl-4 [overflow-wrap:anywhere]">
          {e.creditoLiteral}
        </p>
      ) : null}
      <dl className="flex flex-col gap-3">
        <div>
          <dt className={rotulo}>Autores</dt>
          <dd className="text-leitura [overflow-wrap:anywhere]">
            <Autores autores={e.autores} />
          </dd>
        </div>
        <div>
          <dt className={rotulo}>Licença</dt>
          <dd className="text-leitura [overflow-wrap:anywhere]">
            {e.urlLicenca ? (
              <a href={e.urlLicenca} className="inline-block min-h-11 py-2 underline">
                {e.licenca}
              </a>
            ) : (
              e.licenca
            )}
            {e.notaDaLicenca ? <span>. {e.notaDaLicenca}</span> : null}
          </dd>
        </div>
        <div>
          <dt className={rotulo}>Versão ou data</dt>
          <dd className="text-leitura [overflow-wrap:anywhere]">
            {e.versao}
            {e.urlOrigem ? (
              <>
                {" "}
                (
                <a href={e.urlOrigem} className={linkDeEndereco}>
                  <EnderecoSemOrfao endereco={e.urlOrigem.replace(/^https?:\/\//, "")} />
                </a>
                )
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className={rotulo}>Alterações feitas por nós</dt>
          <dd className="text-leitura [overflow-wrap:anywhere]">{e.alteracoes}</dd>
        </div>
        {e.usadoEm.length > 0 ? (
          <div>
            <dt className={rotulo}>Usado em</dt>
            {/* Frase corrida com os títulos ligados à página de cada Fonte: link de prosa (isento dos
                44 px, WCAG 2.5.8). O ponto final fecha a frase também quando há uma só. */}
            <dd className="text-leitura [overflow-wrap:anywhere]">
              {e.usadoEm.map((f, i) => (
                <Fragment key={f.slug}>
                  {i > 0 ? (i === e.usadoEm.length - 1 ? " e " : ", ") : null}
                  <Link href={`/acervo/${f.slug}`} className="underline">
                    {f.titulo}
                  </Link>
                </Fragment>
              ))}
              .
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

export default async function PaginaCreditos() {
  const entradas = await entradasDaPagina();
  const gerais = entradas.filter((e) => e.grupo === "geral");
  const doAcervo = entradas.filter((e) => e.grupo === "acervo");
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Créditos</h1>
      <p className="text-leitura">O que este site usa, de quem é e sob qual licença.</p>
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {gerais.map((e) => (
          <Entrada key={e.nome} entrada={e} nivel={2} />
        ))}
      </ul>
      {/* Textos do Acervo (ACER-12): página longa e sem acordeão de propósito. Os créditos são para ser
          lidos inteiros e achados por busca (Ctrl+F), e o "Usado em" leva à página de cada Fonte. */}
      {doAcervo.length > 0 ? (
        <section
          aria-labelledby="textos-do-acervo"
          data-slot="creditos-do-acervo"
          className="flex flex-col gap-2"
        >
          <h2 id="textos-do-acervo" className="text-label">
            Textos do Acervo
          </h2>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {doAcervo.map((e) => (
              <Entrada key={e.nome} entrada={e} nivel={3} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
