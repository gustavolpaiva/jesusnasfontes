import { montarCreditos } from "@/modules/creditos/creditos";

// Os registros são lidos uma vez, quando o módulo é carregado (no build, o `next build` carrega a
// página e um registro com campo faltando derruba o build). A página não depende de sessão nem de banco.
//
// Sem `export const dynamic = "force-static"`: o layout raiz é dinâmico de propósito (o nonce da
// política de conteúdo muda a cada requisição, e o tema e o tamanho do texto vêm dos cookies). Com
// `force-static` a página saía sem nonce e sem ler os cookies: medido no e2e, o passo 5 do tamanho do
// texto virava o padrão em /creditos (UI-03). O conteúdo continua vindo só dos registros.
const entradas = montarCreditos();

export const metadata = { title: "Créditos" };

const rotulo = "text-label text-ink-muted";

export default function PaginaCreditos() {
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Créditos</h1>
      <p className="text-leitura">O que este site usa, de quem é e sob qual licença.</p>
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {entradas.map((e) => (
          <li key={e.nome} className="flex flex-col gap-4 py-6">
            <h2 className="text-heading text-[1.5rem] leading-tight">{e.nome}</h2>
            {e.creditoLiteral ? (
              <p className="text-leitura border-l-2 border-rule-strong pl-4 [overflow-wrap:anywhere]">
                {e.creditoLiteral}
              </p>
            ) : null}
            <dl className="flex flex-col gap-3">
              <div>
                <dt className={rotulo}>Autores</dt>
                <dd className="text-leitura [overflow-wrap:anywhere]">{e.autores}</dd>
              </div>
              <div>
                <dt className={rotulo}>Licença</dt>
                <dd className="text-leitura [overflow-wrap:anywhere]">
                  {e.urlLicenca ? (
                    <a href={e.urlLicenca} className="underline">
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
                      <a href={e.urlOrigem} className="break-all underline">
                        {e.urlOrigem.replace(/^https?:\/\//, "")}
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
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
