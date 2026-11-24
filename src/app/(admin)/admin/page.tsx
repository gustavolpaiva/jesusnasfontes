import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import {
  filaDeFichas,
  listarFontesDoPainel,
  pendentesDaFila,
} from "@/modules/acervo/consultas-admin";
import { contarPropostasPendentes } from "@/modules/acervo/consultas-graus";
import { listarConvites } from "@/modules/convites/consultas";
import { exigirAdmin } from "@/modules/identidade/sessao";

// Entrada da administração (UI-SPEC tela 10): as áreas, em linhas separadas por filete, com a pendência de cada uma.
// Uma contagem que não carrega não derruba a página: a linha fica sem contagem e o link segue valendo.
export const dynamic = "force-dynamic";

const plural = (n: number, um: string, varios: string) => (n === 1 ? `1 ${um}` : `${n} ${varios}`);

async function contar<T>(
  ler: () => Promise<T>,
  texto: (v: T) => string | null,
): Promise<string | null> {
  try {
    return texto(await ler());
  } catch (erro) {
    unstable_rethrow(erro);
    return null;
  }
}

export default async function PaginaAdministracao() {
  const sessao = await exigirAdmin();
  const [convites, fontes, fichas, graus] = await Promise.all([
    contar(listarConvites, (l) => {
      const n = l.filter((c) => c.estado === "pendente").length;
      return n === 0 ? "Nenhuma pendência" : plural(n, "convite pendente", "convites pendentes");
    }),
    contar(listarFontesDoPainel, (l) => {
      const n = l.filter((f) => f.emConflito).length;
      return n === 0
        ? "Nenhuma pendência"
        : plural(n, "Fonte em conflito com a carga", "Fontes em conflito com a carga");
    }),
    contar(
      () => filaDeFichas(sessao.sessao.id),
      (fila) => {
        const n = pendentesDaFila(fila);
        return n === 0 ? "Nenhuma pendência" : plural(n, "ficha a verificar", "fichas a verificar");
      },
    ),
    contar(
      () => contarPropostasPendentes(sessao.sessao.id),
      (n) =>
        n === 0
          ? "Nenhuma pendência"
          : plural(n, "proposta de Grau pendente", "propostas de Grau pendentes"),
    ),
  ]);
  const areas = [
    { href: "/admin/convites", rotulo: "Convites", meta: convites },
    { href: "/admin/acervo/fontes", rotulo: "Fontes", meta: fontes },
    { href: "/admin/acervo/fichas", rotulo: "Fichas a verificar", meta: fichas },
    { href: "/admin/acervo/graus", rotulo: "Graus propostos", meta: graus },
  ];
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Administração</h1>
      <p className="text-leitura">
        Convide e acompanhe as pessoas do grupo, cuide das Fontes do Acervo, verifique as fichas e
        aprove os Graus de certeza.
      </p>
      <ul className="flex flex-col border-y border-rule" data-slot="areas-de-administracao">
        {areas.map((a) => (
          <li
            key={a.href}
            className="relative flex min-h-16 flex-col justify-center border-b border-rule py-2 last:border-b-0 hover:bg-paper-soft has-[a:focus-visible]:bg-paper-soft"
          >
            <Link
              href={a.href}
              className="text-ui flex min-h-11 items-center rounded-sm font-semibold text-ink no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {a.rotulo}
            </Link>
            {a.meta ? <span className="text-meta -mt-1 pb-1 text-ink-muted">{a.meta}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
