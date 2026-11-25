import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CAMINHO_LOCK, PASTA_DERIVADOS } from "../../../scripts/acervo/derivados";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  PORTA_BANCO_LOCAL,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// O passo do Acervo do build de produção (plano 02-22), provado de ponta a ponta em PROCESSO NOVO, com a rede
// bloqueada por um módulo carregado antes (tests/support/bloquear-rede.ts). Dois níveis:
//   - o script que o build abre para o passo (`scripts/acervo/carregar.ts`), sobre um banco descartável e uma CÓPIA
//     dos derivados de fixture (cópia, para se poder adulterar sem tocar nos derivados de verdade);
//   - o próprio `scripts/db/build-producao.ts`, em modo de ensaio, com os derivados versionados reais — que é o que
//     a produção carrega.
// O bloqueio vale também para o carregador que o build abre: vai por NODE_OPTIONS, que os filhos herdam. Cada
// processo escreve, ao sair, o relatório das tentativas de rede: o teste confere a lista VAZIA (nenhuma tentativa,
// não só "lançaria") e, quando o passo deve falhar antes de conectar, ZERO conexões abertas.
// Só banco descartável local: o teste não roda no Neon e nenhum derivado versionado é tocado.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const BLOQUEIO = pathToFileURL(path.join(RAIZ, "tests", "support", "bloquear-rede.ts")).href;
const BUILD = "scripts/db/build-producao.ts";
const CARREGADOR = "scripts/acervo/carregar.ts";
const ENSAIO = { VERCEL_ENV: "preview", JNF_ENSAIO_ACERVO: "1" } as const;
const emNeon = () => inject("alvoBanco") === "neon";

const temporarios: string[] = [];
const temporaria = (prefixo: string): string => {
  const pasta = mkdtempSync(path.join(tmpdir(), prefixo));
  temporarios.push(pasta);
  return pasta;
};

type Relatorio = { programa: string; bloqueados: string[]; permitidas: number };
type Resultado = { codigo: number | null; stdout: string; stderr: string; relatorios: Relatorio[] };

let banco: BancoDeExecucao | undefined;
let env: Record<string, string> = {};
let dono: pg.Client;
let pastaDosRelatorios: string;

/**
 * O ambiente do filho: só o indispensável do processo de teste e as credenciais DO BANCO DESCARTÁVEL desta
 * execução. Nenhuma outra variável do ambiente alcança o filho (nem credencial de Neon, nem NODE_OPTIONS de
 * quem roda os testes); valor `undefined` remove a variável.
 */
function ambienteDoFilho(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const filho: Record<string, string> = {};
  for (const nome of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const valor = process.env[nome];
    if (valor !== undefined) filho[nome] = valor;
  }
  Object.assign(filho, env);
  for (const [nome, valor] of Object.entries(extra)) {
    if (valor === undefined) delete filho[nome];
    else filho[nome] = valor;
  }
  return filho as NodeJS.ProcessEnv;
}

/** Roda o Node em processo novo, com o bloqueio de rede carregado ANTES do programa. */
function executar(
  argumentosDoNode: string[],
  ambiente: Record<string, string | undefined>,
): Resultado {
  const antes = new Set(readdirSync(pastaDosRelatorios));
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", BLOQUEIO, ...argumentosDoNode],
    {
      cwd: RAIZ,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: ambienteDoFilho({
        // Os filhos que este processo abrir (o carregador, no build) herdam o bloqueio por aqui.
        NODE_OPTIONS: `--import tsx --import ${BLOQUEIO}`,
        JNF_REDE_RELATORIO_DIR: pastaDosRelatorios,
        ...ambiente,
      }),
    },
  );
  const relatorios = readdirSync(pastaDosRelatorios)
    .filter((nome) => !antes.has(nome))
    .sort()
    .map(
      (nome) => JSON.parse(readFileSync(path.join(pastaDosRelatorios, nome), "utf8")) as Relatorio,
    );
  return { codigo: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", relatorios };
}

/** Um script do produto, como o build o abre (`node --import tsx <script> <argumentos>`). */
const rodar = (
  script: string,
  opcoes: { argumentos?: string[]; ambiente?: Record<string, string | undefined> } = {},
): Resultado => executar([script, ...(opcoes.argumentos ?? [])], opcoes.ambiente ?? {});

const semTentativa = (r: Resultado, quantos: number): Relatorio[] => {
  // Um relatório por processo que rodou (o build e o carregador que ele abriu são dois).
  expect(r.relatorios).toHaveLength(quantos);
  for (const relatorio of r.relatorios) expect(relatorio.bloqueados).toEqual([]);
  return r.relatorios;
};

/** Cópia dos derivados e dos YAMLs de fixture, com um lock próprio, para adulterar sem tocar nos de verdade. */
function copiaDaFixture(): {
  derivados: string;
  argumentos: string[];
  bytes: number;
  gravarLock: (alteracao?: { orcamento_total_bytes?: number }) => void;
} {
  const raiz = temporaria("jnf-passo-build-");
  const fontes = path.join(raiz, "fontes");
  const derivados = path.join(raiz, "derivados");
  mkdirSync(fontes);
  mkdirSync(derivados);
  cpSync(path.join(FIXTURES, "fontes"), fontes, { recursive: true });
  cpSync(path.join(FIXTURES, "derivados"), derivados, { recursive: true });
  const bytes = readFileSync(path.join(derivados, "josefo-antiguidades.json"));
  const lock = path.join(raiz, "lock.json");
  const gravarLock = (alteracao: { orcamento_total_bytes?: number } = {}) =>
    writeFileSync(
      lock,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: alteracao.orcamento_total_bytes ?? 31_457_280,
        derivados: {
          "josefo-antiguidades": {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
        },
      }),
    );
  gravarLock();
  return {
    derivados,
    argumentos: ["--fontes", fontes, "--derivados", derivados, "--lock", lock],
    bytes: bytes.length,
    gravarLock,
  };
}

const contar = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await dono.query(sql, params)).rows[0]?.n ?? -1);
const fontesNoBanco = () => contar("select count(*)::int as n from acervo.fonte");
const paragrafosNoBanco = () => contar("select count(*)::int as n from acervo.fonte_paragrafo");

beforeAll(async () => {
  if (emNeon()) return;
  pastaDosRelatorios = temporaria("jnf-rede-");
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  env = preparado.env;
  dono = new pg.Client({ connectionString: banco.url });
  await dono.connect();
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  await dono?.end().catch(() => {});
  if (banco) await removerBancoDeExecucao(banco.nome);
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(emNeon())("o passo do Acervo do build sem rede", () => {
  it("controle positivo: com o bloqueio carregado, fetch, http, https, net, tls e dns lançam; só o loopback passa", () => {
    const sonda = `
      const http = await import("node:http"), https = await import("node:https");
      const net = await import("node:net"), tls = await import("node:tls"), dns = await import("node:dns");
      // Devolve o nome quando a chamada LANÇOU (o que se quer) e null quando passou.
      const tenta = (nome, f) => { try { const r = f(); if (r && typeof r.destroy === "function") r.destroy(); return null; } catch { return nome; } };
      const lancaram = [
        tenta("fetch", () => fetch("https://exemplo.invalid/")),
        tenta("http.request", () => http.request("http://exemplo.invalid/")),
        tenta("http.get", () => http.get("http://exemplo.invalid/")),
        tenta("https.request", () => https.request("https://exemplo.invalid/")),
        tenta("https.get", () => https.get("https://exemplo.invalid/")),
        tenta("net.connect", () => net.connect(443, "exemplo.invalid")),
        tenta("net.createConnection", () => net.createConnection(443, "exemplo.invalid")),
        tenta("tls.connect", () => tls.connect({ host: "exemplo.invalid", port: 443 })),
        tenta("dns.lookup", () => dns.default.lookup("exemplo.invalid", () => {})),
        tenta("Socket.connect", () => new net.Socket().connect(443, "192.0.2.1")),
      ].filter((x) => x !== null);
      // O loopback passa: conecta no Postgres local de teste.
      await new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.once("connect", () => { s.destroy(); resolve(); });
        s.once("error", reject);
        s.connect(${PORTA_BANCO_LOCAL}, "127.0.0.1");
      });
      console.log("LANCAM " + JSON.stringify(lancaram));
    `;
    const r = executar(["--input-type=module", "-e", sonda], {});
    expect(r.codigo).toBe(0);
    expect(r.stdout).toContain("LANCAM ");
    const lancaram = JSON.parse(
      /\bLANCAM (.+)$/.exec(r.stdout.trimEnd().split("\n").at(-1) ?? "")?.[1] ?? "[]",
    ) as string[];
    expect([...lancaram].sort()).toEqual(
      [
        "fetch",
        "http.get",
        "http.request",
        "https.get",
        "https.request",
        "net.connect",
        "net.createConnection",
        "tls.connect",
        "dns.lookup",
        "Socket.connect",
      ].sort(),
    );
    expect(r.relatorios).toHaveLength(1);
    // Cada uma das dez tentativas ficou registrada pelo nome; a conexão em loopback foi contada à parte.
    expect(r.relatorios[0]?.bloqueados.length).toBe(10);
    expect(r.relatorios[0]?.permitidas).toBe(1);
    const registradas = r.relatorios[0]?.bloqueados.join("\n") ?? "";
    expect(registradas).toContain("tcp://192.0.2.1:443");
    expect(registradas).toContain("fetch:https://exemplo.invalid/");
    expect(registradas).toContain("https.get:http");
    // Nenhuma tentativa foi a do loopback: ele passou.
    expect(registradas).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it.each([
    {
      forma: "um byte a mais no arquivo",
      aviso: "tamanho diferente do lock",
      adulterar: (derivados: string) =>
        appendFileSync(path.join(derivados, "josefo-antiguidades.json"), " "),
    },
    {
      forma: "outro conteúdo com o mesmo tamanho",
      aviso: "sha256 diferente do lock",
      adulterar: (derivados: string) => {
        const arquivo = path.join(derivados, "josefo-antiguidades.json");
        const texto = readFileSync(arquivo, "utf8");
        expect(texto).toContain('"Book 18"');
        writeFileSync(arquivo, texto.replace('"Book 18"', '"Book 19"'));
      },
    },
  ])(
    "com o derivado adulterado ($forma) termina com saída 1, sem abrir conexão",
    ({ aviso, adulterar }) => {
      const copia = copiaDaFixture();
      adulterar(copia.derivados);
      const r = rodar(CARREGADOR, { argumentos: copia.argumentos });
      expect(r.codigo).toBe(1);
      expect(r.stderr).toContain(aviso);
      // O lock é conferido ANTES de abrir conexão: o processo não abriu conexão nenhuma.
      const relatorios = semTentativa(r, 1);
      expect(relatorios[0]?.permitidas).toBe(0);
      expect(relatorios[0]?.programa).toBe("carregar.ts");
    },
  );

  it("com a soma dos derivados acima do orçamento do lock termina com saída 1, sem abrir conexão", () => {
    const copia = copiaDaFixture();
    copia.gravarLock({ orcamento_total_bytes: 1 });
    expect(copia.bytes).toBeGreaterThan(1);
    const r = rodar(CARREGADOR, { argumentos: copia.argumentos });
    expect(r.codigo).toBe(1);
    expect(r.stderr).toContain("soma acima de orcamento_total_bytes");
    expect(semTentativa(r, 1)[0]?.permitidas).toBe(0);
  });

  it("o par ambiente × banco que não casa é recusado antes de gravar", async () => {
    // O passo de PRODUÇÃO (VERCEL_ENV=production) contra o banco descartável, que é marcado `dev`.
    const copia = copiaDaFixture();
    const r = rodar(CARREGADOR, {
      argumentos: copia.argumentos,
      ambiente: { VERCEL_ENV: "production" },
    });
    expect(r.codigo).toBe(1);
    // O carregador só imprime texto de erro nosso: o que sai é a CLASSE da recusa (a mensagem é constante, mas
    // ela não é das classes que o comando imprime).
    expect(r.stderr).toContain('"nome":"AmbienteRecusado"');
    expect(await fontesNoBanco()).toBe(0);
    expect(await paragrafosNoBanco()).toBe(0);
    // O outro sentido (ensaio de Preview contra banco `producao`) é a mesma função com os argumentos trocados:
    // provado no teste de unidade (`decidirAmbiente`), que o carregador chama logo depois de ler o marcador.
  });

  it("o passo do Acervo termina com saída 0 e a Fonte de fixture carregada, sem nenhuma tentativa de rede", async () => {
    const copia = copiaDaFixture();
    const r = rodar(CARREGADOR, { argumentos: copia.argumentos });
    expect(r.codigo).toBe(0);
    // Como o `acervo:load`: a não publicada sem derivado é pulada, e o carregador avisa.
    expect(r.stdout).toContain("puladas (não publicadas e sem derivado): mara-bar-serapiao");
    const relatorios = semTentativa(r, 1);
    expect(relatorios[0]?.programa).toBe("carregar.ts");
    // A conexão com o Postgres local é a única que o bloqueio deixa passar, e ela foi aberta.
    expect(relatorios[0]?.permitidas).toBeGreaterThanOrEqual(1);
    expect(await fontesNoBanco()).toBe(1);
    // Os dois parágrafos do derivado de fixture (18.63 e 20.197).
    expect(await paragrafosNoBanco()).toBe(2);
  });

  it("fora do ensaio a Preview pula sem ler credencial nem abrir conexão", () => {
    // Sem JNF_ENSAIO_ACERVO e com credenciais que não valem nada: se o passo tentasse ler ou conectar, falharia
    // (ou o bloqueio registraria a tentativa).
    const r = rodar(BUILD, {
      ambiente: {
        VERCEL_ENV: "preview",
        NEON_HOST: "exemplo.invalid",
        JNF_APP_PASSWORD: "nao-vale",
        JNF_CARGA_PASSWORD: "nao-vale",
        JNF_MIGRA_PASSWORD: "nao-vale",
      },
    });
    expect(r.codigo).toBe(0);
    expect(r.stdout).toBe("passo de produção: pulado (VERCEL_ENV=preview)\n");
    // Só o próprio build rodou; não abriu conexão nenhuma e não tentou rede nenhuma.
    expect(semTentativa(r, 1)[0]?.permitidas).toBe(0);
  });

  it("o build em modo de ensaio roda SÓ o passo do Acervo, sem rede, e carrega as Fontes dos derivados versionados", async () => {
    // Os derivados versionados de verdade: é o que a produção carrega.
    const lock = JSON.parse(readFileSync(CAMINHO_LOCK, "utf8")) as {
      derivados: Record<string, { bytes: number }>;
    };
    const slugs = Object.keys(lock.derivados).sort();
    expect(slugs.length).toBeGreaterThan(1);
    for (const slug of slugs)
      expect(readFileSync(path.join(PASTA_DERIVADOS, `${slug}.json`)).length, slug).toBe(
        lock.derivados[slug]?.bytes,
      );
    const r = rodar(BUILD, { ambiente: { ...ENSAIO } });
    expect(r.codigo).toBe(0);
    // Anuncia o ensaio, não os passos da produção, e conclui.
    expect(r.stdout).toContain("passo de ensaio do Acervo: rodando");
    expect(r.stdout).not.toMatch(/passo de produção: (migrações|Bíblia|conteúdo|Admin inicial)/);
    expect(r.stdout).toContain("passo de ensaio do Acervo: concluído");
    expect(r.stdout).toContain(`fontes=${slugs.length} `);
    // Dois processos (o build e o carregador que ele abriu), nenhum deles com tentativa de rede.
    const relatorios = semTentativa(r, 2);
    expect(relatorios.map((x) => x.programa).sort()).toEqual(["build-producao.ts", "carregar.ts"]);
    expect(relatorios.find((x) => x.programa === "carregar.ts")?.permitidas).toBeGreaterThanOrEqual(
      1,
    );
    expect(await fontesNoBanco()).toBe(slugs.length);
    const publicadas = await dono.query<{ slug: string }>(
      "select slug from acervo.fonte where publicada order by slug",
    );
    expect(publicadas.rows.map((x) => x.slug)).toEqual(slugs);
  }, 360_000);

  it("o código 3 do carregador (conflito com o painel) vira aviso, uma linha por conflito, e o build segue", async () => {
    // A edição "do painel" em duas Fontes: o mesmo efeito que a tela produz (o valor atual difere do que a última
    // carga gravou). Nada foi tocado no arquivo.
    const editadas = ["josefo-antiguidades", "luciano-peregrino"];
    await dono.query(
      "update acervo.fonte set limites_pt = 'Limites editados no painel para o teste.' where slug = any($1::text[])",
      [editadas],
    );
    const r = rodar(BUILD, { ambiente: { ...ENSAIO } });
    expect(r.codigo).toBe(0);
    const linhas = r.stdout.trimEnd().split("\n");
    const avisos = linhas.filter((l) => l.includes(": aviso: "));
    // Uma linha de aviso por conflito, e o aviso é a linha do carregador (a Fonte e os campos em conflito).
    expect(avisos).toHaveLength(2);
    for (const slug of editadas)
      expect(avisos.join("\n")).toContain(
        `aviso: conflito: ${slug} foi editada no painel (limites_pt)`,
      );
    // O build seguiu: as outras Fontes ficaram como estavam e nada foi sobrescrito.
    expect(r.stdout).toContain("inseridos=0 atualizados=0");
    expect(linhas.at(-1)).toBe("passo de ensaio do Acervo: concluído");
    semTentativa(r, 2);
    const conflitos = await dono.query<{
      slug: string;
      conflito_carga: string[];
      limites_pt: string;
    }>(
      "select slug, conflito_carga, limites_pt from acervo.fonte where slug = any($1::text[]) order by slug",
      [editadas],
    );
    for (const f of conflitos.rows) {
      expect(f.conflito_carga).toEqual(["limites_pt"]);
      expect(f.limites_pt).toBe("Limites editados no painel para o teste.");
    }
  }, 360_000);

  it("qualquer outro código do passo para o build (não vira aviso)", async () => {
    // O carregador deixa de enxergar o marcador de ambiente: sai com 1 antes de gravar qualquer coisa.
    await dono.query("revoke select on acervo.ambiente from jnf_carga");
    try {
      const r = rodar(BUILD, { ambiente: { ...ENSAIO } });
      expect(r.codigo).toBe(1);
      expect(r.stdout).toContain("passo de ensaio do Acervo: rodando");
      expect(`${r.stdout}\n${r.stderr}`).toContain(
        "passo de ensaio do Acervo: Acervo falhou; o build para",
      );
      expect(r.stdout).not.toContain("concluído");
      expect(r.stdout).not.toContain("aviso:");
      semTentativa(r, 2);
    } finally {
      await dono.query("grant select on acervo.ambiente to jnf_carga");
    }
  }, 360_000);
});
