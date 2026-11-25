import dns from "node:dns";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename, join } from "node:path";
import tls from "node:tls";

// Bloqueio de rede para TESTE (plano 02-22). Carregado ANTES do programa, por `--import` — e por `NODE_OPTIONS`,
// que os filhos herdam: o passo do build do Acervo é quem abre o carregador em outro processo, e é o carregador
// quem tem de estar sem rede.
//
//   node --import tsx --import ./tests/support/bloquear-rede.ts scripts/acervo/carregar.ts
//
// O que faz: `fetch`, `http`, `https`, `net`, `tls` e `dns` passam a lançar; e a passagem final de toda conexão TCP
// (`net.Socket.prototype.connect`, por onde o http, o https, o fetch e o próprio `pg` passam) deixa passar SÓ o
// loopback — o Postgres descartável de teste, sem o qual o carregador não gravaria — e lança para qualquer outro
// destino, ANTES de qualquer consulta de DNS. Toda tentativa fica registrada em memória.
//
// O relatório é o que prova "sem nenhuma rede": com `JNF_REDE_RELATORIO_DIR` o processo escreve, ao sair, um JSON por
// pid nessa pasta (`rede-<pid>.json`) com as tentativas bloqueadas e quantas conexões em loopback abriu. O teste confere
// a lista vazia — não só que a chamada lançaria — e, quando o passo deve falhar antes de conectar, zero conexões.

type Estado = { bloqueados: string[]; permitidas: number };

declare global {
  var __jnfBloqueioDeRede: Estado | undefined;
}

class RedeBloqueada extends Error {
  constructor(chamada: string) {
    super(`rede bloqueada em teste: ${chamada}`);
    this.name = "RedeBloqueada";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const ehLoopback = (host: string): boolean => host === "" || LOOPBACK.has(host);

type Destino = { rede: boolean; host: string; porta: string };

/** O destino de uma chamada a `Socket#connect`: (opções), (porta, host) ou (caminho de socket local). */
function destinoDe(args: readonly unknown[]): Destino {
  const [primeiro, segundo] = args;
  // Caminho em vez de porta é socket local (IPC), não rede.
  if (typeof primeiro === "string") return { rede: false, host: "", porta: "" };
  if (primeiro !== null && typeof primeiro === "object") {
    const o = primeiro as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === "string") return { rede: false, host: "", porta: "" };
    return {
      rede: true,
      host: typeof o.host === "string" ? o.host : "localhost",
      porta: String(o.port ?? ""),
    };
  }
  // Sem host, o destino é o localhost.
  return {
    rede: true,
    host: typeof segundo === "string" ? segundo : "localhost",
    porta: String(primeiro ?? ""),
  };
}

/** O endereço pedido, só para o registro e a mensagem (nome ou host, nunca o corpo). */
function enderecoDe(valor: unknown): string {
  if (typeof valor === "string") return valor;
  const host = (valor as { host?: unknown } | null)?.host;
  return typeof host === "string" ? host : "requisição";
}

type Funcao = (...args: unknown[]) => unknown;
const comoRegistro = (alvo: unknown): Record<string, Funcao> => alvo as Record<string, Funcao>;

/** Troca uma função pública de rede por outra que lança; devolve a original. */
function bloquearSempre(
  alvo: unknown,
  nome: string,
  descrever: (...args: unknown[]) => string,
): void {
  const registro = comoRegistro(alvo);
  registro[nome] = (...args: unknown[]) => {
    throw bloquear(descrever(...args));
  };
}

// O estado é lido pelas funções abaixo; nasce em `instalarBloqueioDeRede`.
let estado: Estado;

function bloquear(chamada: string): Error {
  estado.bloqueados.push(chamada);
  return new RedeBloqueada(chamada);
}

/** Instala o bloqueio no processo (uma vez) e devolve o estado, onde as tentativas ficam registradas. */
export function instalarBloqueioDeRede(): Estado {
  if (globalThis.__jnfBloqueioDeRede) return globalThis.__jnfBloqueioDeRede;
  estado = { bloqueados: [], permitidas: 0 };
  globalThis.__jnfBloqueioDeRede = estado;

  // A passagem final de toda conexão TCP. Vale mesmo para biblioteca que crie o socket por conta própria (o `pg`).
  const prototipo = net.Socket.prototype as unknown as Record<string, Funcao>;
  const conecta = prototipo.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;
  prototipo.connect = function (this: net.Socket, ...args: unknown[]) {
    const destino = destinoDe(args);
    if (!destino.rede || ehLoopback(destino.host)) {
      estado.permitidas += 1;
      return conecta.apply(this, args);
    }
    throw bloquear(`tcp://${destino.host}:${destino.porta}`);
  };

  // As portas de rede por nome: nenhuma delas tem o que fazer numa carga que só lê o disco.
  bloquearSempre(globalThis, "fetch", (entrada: unknown) => `fetch:${enderecoDe(entrada)}`);
  for (const [modulo, rotulo] of [
    [http, "http"],
    [https, "https"],
  ] as const) {
    bloquearSempre(
      modulo,
      "request",
      (opcoes: unknown) => `${rotulo}.request:${enderecoDe(opcoes)}`,
    );
    bloquearSempre(modulo, "get", (endereco: unknown) => `${rotulo}.get:${enderecoDe(endereco)}`);
  }
  // TLS nunca é preciso para o banco local.
  bloquearSempre(tls, "connect", (opcoes: unknown) => `tls.connect:${enderecoDe(opcoes)}`);
  // `net.connect` e `net.createConnection`: em loopback seguem para a função de verdade (que passa pelo
  // `Socket#connect` acima e é contada lá); fora dele, lançam.
  for (const nome of ["connect", "createConnection"] as const) {
    const registro = comoRegistro(net);
    const original = registro[nome] as Funcao;
    registro[nome] = (...args: unknown[]) => {
      const destino = destinoDe(args);
      if (!destino.rede || ehLoopback(destino.host)) return original(...args);
      throw bloquear(`net.${nome}:${destino.host}:${destino.porta}`);
    };
  }
  // Nome fora do loopback nunca chega ao resolvedor: a consulta de DNS já contataria a rede.
  const registroDns = comoRegistro(dns);
  const lookup = registroDns.lookup as Funcao;
  registroDns.lookup = (host: unknown, ...resto: unknown[]) => {
    if (typeof host === "string" && ehLoopback(host)) return lookup(host, ...resto);
    throw bloquear(`dns.lookup:${String(host)}`);
  };

  // `import { request } from "node:https"` (nome, não o objeto padrão) lê a ligação do módulo ESM, que só enxerga
  // a troca depois desta chamada: sem ela, o bloqueio valeria só para quem usa o objeto padrão (medido).
  syncBuiltinESMExports();

  return estado;
}

instalarBloqueioDeRede();

// O relatório ao sair: um JSON por processo, para o teste ler o do build e o do carregador que ele abriu.
const pastaDoRelatorio = process.env.JNF_REDE_RELATORIO_DIR;
if (pastaDoRelatorio) {
  process.on("exit", () => {
    const atual = instalarBloqueioDeRede();
    writeFileSync(
      join(pastaDoRelatorio, `rede-${process.pid}.json`),
      JSON.stringify(
        {
          programa: basename(process.argv[1] ?? ""),
          bloqueados: atual.bloqueados,
          permitidas: atual.permitidas,
        },
        null,
        2,
      ),
    );
  });
}
