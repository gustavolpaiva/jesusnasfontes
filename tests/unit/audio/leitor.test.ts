import { describe, expect, it, vi } from "vitest";
import { type DependenciasDoLeitor, LeitorEmVoz } from "@/modules/audio/leitor";
import type { FalaLike, SinteseLike, VozLike } from "@/modules/audio/vozes";

// Motor falso em memória: guarda a fila, dispara `start` no começo de cada fala e deixa o teste
// terminar a fala atual. `cancel` dispara `error: canceled` nas falas da fila, como os motores reais.
class MotorFalso implements SinteseLike {
  fila: FalaLike[] = [];
  falando: FalaLike | null = null;
  cancelamentos = 0;
  falados: string[] = [];
  voz: VozLike = { name: "Marcia", lang: "pt-BR", voiceURI: "Marcia", localService: true };
  speak(fala: FalaLike) {
    this.fila.push(fala);
    this.andar();
  }
  cancel() {
    this.cancelamentos++;
    const perdidas = [...(this.falando ? [this.falando] : []), ...this.fila];
    this.fila = [];
    this.falando = null;
    for (const f of perdidas) f.onerror?.({ error: "canceled" });
  }
  getVoices() {
    return [this.voz];
  }
  private andar() {
    if (this.falando || this.fila.length === 0) return;
    this.falando = this.fila.shift() ?? null;
    this.falados.push(this.falando?.text ?? "");
    this.falando?.onstart?.({});
  }
  terminarAtual() {
    const f = this.falando;
    this.falando = null;
    f?.onend?.({});
    this.andar();
  }
  falharAtual(erro = "synthesis-failed") {
    this.falando?.onerror?.({ error: erro });
  }
}

function criar(motor = new MotorFalso(), extra: Partial<DependenciasDoLeitor> = {}) {
  const leitor = new LeitorEmVoz({
    sintese: () => motor,
    criarFala: (texto): FalaLike => ({
      text: texto,
      lang: "",
      voice: null,
      onstart: null,
      onend: null,
      onerror: null,
    }),
    opcoesDaEscolha: { armazenamento: null },
    ...extra,
  });
  return { leitor, motor };
}

const TRECHOS = ["um.", "dois.", "três.", "quatro."];

describe("LeitorEmVoz", () => {
  it("começa ocioso e não fala nada sozinho nem depois de preparar", async () => {
    const { leitor, motor } = criar();
    expect(leitor.instantaneo().estado).toBe("ocioso");
    await leitor.preparar();
    expect(leitor.instantaneo().estado).toBe("ocioso");
    expect(motor.falados).toEqual([]);
    expect(motor.fila).toEqual([]);
  });

  it("ciclo completo: ouvir, pausar, continuar, parar", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(true);
    // Tudo enfileirado no toque, de uma vez; o primeiro já começou.
    expect(leitor.instantaneo()).toMatchObject({
      estado: "lendo",
      dono: "estudo",
      trecho: 0,
      total: 4,
    });
    expect(motor.falados).toEqual(["um."]);
    expect(motor.fila.map((f) => f.text)).toEqual(["dois.", "três.", "quatro."]);
    // A voz escolhida vai em cada fala.
    expect(motor.falando?.voice?.name).toBe("Marcia");
    expect(motor.falando?.lang).toBe("pt-BR");

    motor.terminarAtual();
    expect(leitor.instantaneo().trecho).toBe(1);
    leitor.pausar();
    expect(leitor.instantaneo()).toMatchObject({ estado: "pausado", trecho: 1, dono: "estudo" });
    expect(motor.fila).toEqual([]);
    expect(motor.falando).toBeNull();

    leitor.continuar();
    expect(leitor.instantaneo()).toMatchObject({ estado: "lendo", trecho: 1 });
    // Recomeça do trecho em que parou, não do começo e não do seguinte.
    expect(motor.falados.slice(-1)).toEqual(["dois."]);
    expect(motor.fila.map((f) => f.text)).toEqual(["três.", "quatro."]);

    leitor.parar();
    expect(leitor.instantaneo()).toMatchObject({ estado: "ocioso", dono: null, trecho: 0 });
    expect(motor.fila).toEqual([]);
    expect(motor.falando).toBeNull();
  });

  it("pausar e continuar recomeçam do trecho certo, também em pausas repetidas", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(TRECHOS, "estudo");
    motor.terminarAtual();
    motor.terminarAtual();
    expect(leitor.instantaneo().trecho).toBe(2);
    leitor.pausar();
    leitor.continuar();
    expect(motor.falados.slice(-1)).toEqual(["três."]);
    leitor.pausar();
    leitor.continuar();
    expect(motor.falados.slice(-1)).toEqual(["três."]);
    motor.terminarAtual();
    expect(leitor.instantaneo().trecho).toBe(3);
  });

  it("o fim do último trecho volta a ocioso", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(["só um."], "texto");
    motor.terminarAtual();
    expect(leitor.instantaneo()).toMatchObject({ estado: "ocioso", dono: null });
  });

  it("o cancelamento que o próprio leitor provoca não vira falha", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(TRECHOS, "estudo");
    leitor.pausar();
    leitor.continuar();
    leitor.parar();
    expect(leitor.instantaneo().estado).toBe("ocioso");
    expect(motor.cancelamentos).toBeGreaterThan(0);
  });

  it("erro de fala leva a falha, e tocar de novo recomeça", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(TRECHOS, "estudo");
    motor.falharAtual("synthesis-failed");
    expect(leitor.instantaneo()).toMatchObject({ estado: "falha", dono: "estudo" });
    expect(motor.fila).toEqual([]);
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(true);
    expect(leitor.instantaneo().estado).toBe("lendo");
    expect(motor.falados.slice(-1)).toEqual(["um."]);
  });

  it("iniciar o outro controle interrompe o primeiro", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(TRECHOS, "estudo");
    motor.terminarAtual();
    leitor.iniciar(["texto um.", "texto dois."], "texto");
    expect(leitor.instantaneo()).toMatchObject({
      estado: "lendo",
      dono: "texto",
      trecho: 0,
      total: 2,
    });
    expect(motor.falados.slice(-1)).toEqual(["texto um."]);
    expect(motor.fila.map((f) => f.text)).toEqual(["texto dois."]);
    // O fim do primeiro não mexe no estado do segundo.
    leitor.parar();
    expect(leitor.instantaneo().estado).toBe("ocioso");
  });

  it("iniciar durante a pausa de outro controle começa o novo", async () => {
    const { leitor, motor } = criar();
    await leitor.preparar();
    leitor.iniciar(TRECHOS, "estudo");
    leitor.pausar();
    leitor.iniciar(["novo."], "texto");
    expect(leitor.instantaneo()).toMatchObject({ estado: "lendo", dono: "texto" });
    expect(motor.falados.slice(-1)).toEqual(["novo."]);
  });

  it("sem voz em português: sem-voz, e iniciar não faz nada", async () => {
    const motor = new MotorFalso();
    motor.voz = { name: "Inglesa", lang: "en-US", voiceURI: "Inglesa", localService: true };
    vi.useFakeTimers();
    const { leitor } = criar(motor, { opcoesDaEscolha: { armazenamento: null, esperaMs: 100 } });
    const p = leitor.preparar();
    await vi.advanceTimersByTimeAsync(10);
    expect(leitor.instantaneo().estado).toBe("procurando");
    await vi.advanceTimersByTimeAsync(200);
    await p;
    vi.useRealTimers();
    expect(leitor.instantaneo().estado).toBe("sem-voz");
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(false);
    expect(motor.falados).toEqual([]);
  });

  it("sem a API: sem-suporte, e nada de iniciar", async () => {
    const { leitor } = criar(undefined, { sintese: () => null });
    await leitor.preparar();
    expect(leitor.instantaneo().estado).toBe("sem-suporte");
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(false);
  });

  it("só pt-PT: funciona e marca o aviso do sotaque", async () => {
    const motor = new MotorFalso();
    motor.voz = { name: "Joana", lang: "pt-PT", voiceURI: "Joana", localService: true };
    const { leitor } = criar(motor);
    await leitor.preparar();
    expect(leitor.instantaneo()).toMatchObject({ estado: "ocioso", avisoPortugal: true });
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(true);
  });

  it("não inicia antes de preparar nem sem texto; pausar, continuar e parar fora de hora não fazem nada", async () => {
    const { leitor, motor } = criar();
    expect(leitor.iniciar(TRECHOS, "estudo")).toBe(false);
    await leitor.preparar();
    expect(leitor.iniciar([], "estudo")).toBe(false);
    leitor.pausar();
    leitor.continuar();
    leitor.parar();
    expect(motor.cancelamentos).toBe(0);
    expect(leitor.instantaneo().estado).toBe("ocioso");
  });

  it("quem assina é avisado a cada mudança e a identidade do instantâneo só muda com ela", async () => {
    const { leitor } = criar();
    await leitor.preparar();
    const ouvinte = vi.fn();
    const sair = leitor.assinar(ouvinte);
    const antes = leitor.instantaneo();
    expect(leitor.instantaneo()).toBe(antes);
    leitor.iniciar(TRECHOS, "estudo");
    expect(ouvinte).toHaveBeenCalled();
    expect(leitor.instantaneo()).not.toBe(antes);
    sair();
    const n = ouvinte.mock.calls.length;
    leitor.parar();
    expect(ouvinte).toHaveBeenCalledTimes(n);
  });

  it("erro ao enfileirar a fala (speak lança) leva a falha", async () => {
    const motor = new MotorFalso();
    const { leitor } = criar(motor);
    await leitor.preparar();
    motor.speak = () => {
      throw new Error("negado");
    };
    leitor.iniciar(TRECHOS, "estudo");
    expect(leitor.instantaneo().estado).toBe("falha");
  });
});
