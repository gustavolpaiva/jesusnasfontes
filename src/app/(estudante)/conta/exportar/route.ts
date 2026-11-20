import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import { exportarDados } from "@/modules/privacidade/exportar";

// Todos os dados da pessoa em um arquivo JSON (PRIV-03). Só a conta da sessão; resposta nunca guardada
// em cache e entregue como anexo; nada do conteúdo vai ao registro (T-01-45).
// Abre também para quem não aceitou a versão atual do aviso (decisão do dono, 20/11/2026): levar os
// próprios dados não depende de aceitar o tratamento. A sessão (e o segundo fator do Admin) continua
// exigida e a conta é sempre a da sessão.
export const dynamic = "force-dynamic";

const CABECALHOS = {
  "Content-Type": "application/json; charset=utf-8",
  "Content-Disposition": 'attachment; filename="jesus-nas-fontes-meus-dados.json"',
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(): Promise<Response> {
  const { usuario } = await exigirSessao({ exigirConsentimento: false });
  try {
    const dados = await exportarDados(usuario.id);
    return new Response(JSON.stringify(dados, null, 2), { headers: CABECALHOS });
  } catch (erro) {
    registrarErro("exportar-dados", erro);
    return new Response(JSON.stringify({ erro: "falha" }), {
      status: 500,
      headers: { ...CABECALHOS, "Content-Disposition": "inline" },
    });
  }
}
