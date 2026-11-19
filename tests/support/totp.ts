import { createHmac } from "node:crypto";

// Código de aplicativo autenticador pelo RFC 6238 (HMAC-SHA1, passo de 30 s, 6 dígitos), com
// node:crypto e sem pacote. A chave vem em base32, como a tela mostra.

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodificarBase32(texto: string): Buffer {
  const limpo = texto.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const c of limpo) {
    const v = ALFABETO.indexOf(c);
    if (v < 0) throw new Error("Chave base32 inválida");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// `instante` em milissegundos: os testes injetam o passo (±30 s) em vez de esperar o relógio.
export function gerarTotp(segredoBase32: string, instante: number = Date.now()): string {
  const contador = Math.floor(instante / 1000 / 30);
  const mensagem = Buffer.alloc(8);
  mensagem.writeBigUInt64BE(BigInt(contador));
  const hmac = createHmac("sha1", decodificarBase32(segredoBase32)).update(mensagem).digest();
  const deslocamento = (hmac[hmac.length - 1] as number) & 0x0f;
  const numero =
    (((hmac[deslocamento] as number) & 0x7f) << 24) |
    (((hmac[deslocamento + 1] as number) & 0xff) << 16) |
    (((hmac[deslocamento + 2] as number) & 0xff) << 8) |
    ((hmac[deslocamento + 3] as number) & 0xff);
  return String(numero % 1_000_000).padStart(6, "0");
}
