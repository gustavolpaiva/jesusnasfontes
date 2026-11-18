import Link from "next/link";
import { Button } from "@/components/ui/button";
import { confirmarEntrada } from "@/modules/identidade/entrada";

export const metadata = { referrer: "no-referrer" as const, robots: { index: false } };

// O GET só mostra a tela e nunca consulta o banco: um leitor automático que busca o link não o
// gasta, e a tela é a mesma para qualquer token. Só o POST do botão consome o link.
export default async function PaginaConfirmar({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; invalido?: string }>;
}) {
  const { token, invalido } = await searchParams;
  if (!token || invalido === "1" || token.length > 128) {
    return (
      <div className="coluna-leitura flex flex-col gap-6">
        <h1 className="text-display">Este link não vale mais</h1>
        <p className="text-leitura">
          Ele pode ter vencido ou já ter sido usado. Peça um novo acesso ou use o código de 6
          dígitos do mesmo e-mail.
        </p>
        <Button asChild variant="primary" className="w-full">
          <Link href="/entrar">Pedir novo acesso</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="coluna-leitura flex flex-col gap-6">
      <h1 className="text-display">Confirmar entrada</h1>
      <p className="text-leitura">
        Toque no botão para entrar neste aparelho. Este passo evita que programas de e-mail usem o
        link antes de você.
      </p>
      <form action={confirmarEntrada} className="flex flex-col gap-6">
        <input type="hidden" name="token" value={token} />
        <BotaoEntrar />
      </form>
    </div>
  );
}

function BotaoEntrar() {
  return (
    <Button type="submit" variant="primary" className="w-full">
      Entrar
    </Button>
  );
}
