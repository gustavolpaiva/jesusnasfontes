import type { Page } from "@playwright/test";

// speechSynthesis falso para o Playwright (plano 01-17). O navegador dos testes não tem voz de verdade,
// e o que se prova aqui é o COMPORTAMENTO do produto diante da API (o que enfileira, o que cancela, o
// que mostra sem voz). A voz real (Safari e Chrome de aparelho) NÃO é exercida por este falso.
//
// O falso fica em `window.__fala`, para o teste ler o que foi enfileirado e conduzir os eventos:
//   enfileiradas  todo texto passado a `speak`, na ordem
//   falados       os que o "motor" começou a falar
//   falando       o texto em fala agora (ou null)
//   cancelamentos quantas vezes `cancel` foi chamado
//   vozUsada, linguaUsada  da última fala que começou
//   terminar()    termina a fala atual (o motor passa à próxima, como o real)
//   falhar(erro)  dispara `error` na fala atual

export type VozFalsa = { name: string; lang: string; localService?: boolean };

export type ConfigFalaFalsa = {
  /** Vozes do aparelho. `null` = o navegador não tem a API de fala. */
  vozes: VozFalsa[] | null;
  /** As vozes só aparecem depois deste tempo (evento `voiceschanged`), como no Chrome. */
  chegamEmMs?: number;
};

export const VOZ_PT_BR: VozFalsa = { name: "Voz de teste BR", lang: "pt-BR", localService: true };
export const VOZ_PT_PT: VozFalsa = { name: "Voz de teste PT", lang: "pt-PT", localService: true };
export const VOZ_EN: VozFalsa = { name: "Voice test EN", lang: "en-US", localService: true };

export type EstadoDaFala = {
  enfileiradas: string[];
  falados: string[];
  falando: string | null;
  cancelamentos: number;
  vozUsada: string | null;
  linguaUsada: string | null;
};

const SCRIPT = (config: ConfigFalaFalsa) => `(() => {
  const cfg = ${JSON.stringify(config)};
  const registro = {
    enfileiradas: [], falados: [], falando: null, cancelamentos: 0, vozUsada: null, linguaUsada: null,
  };
  window.__fala = registro;
  if (cfg.vozes === null) {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined });
    return;
  }
  class Fala {
    constructor(texto) {
      this.text = texto === undefined ? "" : String(texto);
      this.lang = ""; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1;
      this.onstart = null; this.onend = null; this.onerror = null;
    }
  }
  const todas = cfg.vozes.map((v) => ({
    name: v.name, lang: v.lang, voiceURI: v.name, localService: v.localService !== false, default: false,
  }));
  class Sintese extends EventTarget {
    constructor() { super(); this.fila = []; this.atual = null; this.visiveis = typeof cfg.chegamEmMs === "number" ? [] : todas; }
    getVoices() { return this.visiveis; }
    speak(fala) { registro.enfileiradas.push(fala.text); this.fila.push(fala); this.andar(); }
    cancel() {
      registro.cancelamentos++;
      const perdidas = (this.atual ? [this.atual] : []).concat(this.fila);
      this.fila = []; this.atual = null; registro.falando = null;
      // Como nos motores reais, o cancelamento chega depois, como erro "canceled".
      setTimeout(() => perdidas.forEach((f) => f.onerror && f.onerror({ error: "canceled" })), 0);
    }
    andar() {
      if (this.atual || this.fila.length === 0) return;
      const fala = this.fila.shift();
      this.atual = fala; registro.falando = fala.text; registro.falados.push(fala.text);
      registro.vozUsada = fala.voice ? fala.voice.name : null; registro.linguaUsada = fala.lang;
      setTimeout(() => { if (this.atual === fala && fala.onstart) fala.onstart({}); }, 0);
    }
  }
  const sintese = new Sintese();
  registro.terminar = () => {
    const fala = sintese.atual;
    if (!fala) return false;
    sintese.atual = null; registro.falando = null;
    if (fala.onend) fala.onend({});
    sintese.andar();
    return true;
  };
  registro.falhar = (erro) => {
    const fala = sintese.atual;
    if (fala && fala.onerror) fala.onerror({ error: erro || "synthesis-failed" });
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: sintese });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Fala });
  if (typeof cfg.chegamEmMs === "number") {
    setTimeout(() => { sintese.visiveis = todas; sintese.dispatchEvent(new Event("voiceschanged")); }, cfg.chegamEmMs);
  }
})();`;

/** Instala o falso antes de qualquer script da página. */
export async function instalarFalaFalsa(page: Page, config: ConfigFalaFalsa): Promise<void> {
  await page.addInitScript({ content: SCRIPT(config) });
}

export async function estadoDaFala(page: Page): Promise<EstadoDaFala> {
  return page.evaluate(() => {
    const f = (window as unknown as { __fala: EstadoDaFala }).__fala;
    return {
      enfileiradas: [...f.enfileiradas],
      falados: [...f.falados],
      falando: f.falando,
      cancelamentos: f.cancelamentos,
      vozUsada: f.vozUsada,
      linguaUsada: f.linguaUsada,
    };
  });
}

/** Termina a fala atual; o falso passa à próxima da fila. */
export async function terminarFala(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window as unknown as { __fala: { terminar: () => boolean } }).__fala.terminar(),
  );
}

/** Faz o motor falso errar na fala atual. */
export async function falharFala(page: Page, erro = "synthesis-failed"): Promise<void> {
  await page.evaluate(
    (e) => (window as unknown as { __fala: { falhar: (e: string) => void } }).__fala.falhar(e),
    erro,
  );
}
