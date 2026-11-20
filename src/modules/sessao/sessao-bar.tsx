import { registrarErro } from "@/lib/registro";
import { faixaDaSessao, type SessaoDoHistorico, tituloDoEstudo } from "./consultas";
import { type EstadoDaFaixa, FaixaDaSessao } from "./faixa-da-sessao";
import { formatarData, formatarDuracao, formatarHora, mesmoDia } from "./formato";

// A faixa da Sessão (tela 6, TRIL-03): fica no topo de /trilhas e de /estudos/[slug]. Componente do
// servidor: lê a Sessão aberta (ou a última) pela RLS do Estudante e entrega à faixa do navegador tudo
// já formatado, no fuso de São Paulo. Se a leitura falha, a faixa some e a página segue de pé: o erro vai
// ao registro só com o contexto e o código.

function textoDaUltima(u: SessaoDoHistorico): string {
  const fim = mesmoDia(u.checkInEm, u.checkOutEm)
    ? formatarHora(u.checkOutEm)
    : `${formatarData(u.checkOutEm)}, ${formatarHora(u.checkOutEm)}`;
  return `${formatarData(u.checkInEm)}, ${formatarHora(u.checkInEm)} a ${fim} (${formatarDuracao(u.minutos)})`;
}

export async function SessaoBar({
  estudanteId,
  estudoSlug,
}: {
  estudanteId: string;
  /** O Estudo da tela, quando há um: o check-in abre nele e o botão leva o título no nome acessível. */
  estudoSlug?: string;
}) {
  let estado: EstadoDaFaixa;
  let estudoAtual: { slug: string; titulo: string } | null = null;
  try {
    const [faixa, titulo] = await Promise.all([
      faixaDaSessao(estudanteId),
      estudoSlug ? tituloDoEstudo(estudoSlug) : Promise.resolve(null),
    ]);
    // Slug que não existe: a página do Estudo responde 404 e não há faixa a mostrar.
    if (estudoSlug && titulo === null) return null;
    if (estudoSlug && titulo !== null) estudoAtual = { slug: estudoSlug, titulo };
    if (faixa.aberta) {
      const { checkInEm } = faixa.aberta;
      // Aberta em outro dia: mostra a data junto da hora.
      const desde = mesmoDia(checkInEm, new Date())
        ? formatarHora(checkInEm)
        : `${formatarData(checkInEm)}, ${formatarHora(checkInEm)}`;
      estado = {
        tipo: "aberta",
        sessaoId: faixa.aberta.id,
        desde,
        estudo: faixa.aberta.estudoTitulo,
      };
    } else {
      estado = { tipo: "nenhuma", ultima: faixa.ultima ? textoDaUltima(faixa.ultima) : null };
    }
  } catch (erro) {
    registrarErro("sessao-faixa", erro);
    return null;
  }
  return <FaixaDaSessao estado={estado} estudoAtual={estudoAtual} />;
}
