import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ArmazenamentoLike,
  CHAVE_DA_VOZ,
  escolherVoz,
  type FalaLike,
  type SinteseLike,
  type VozLike,
} from "@/modules/audio/vozes";

const voz = (name: string, lang: string, localService = true): VozLike => ({
  name,
  lang,
  voiceURI: name,
  localService,
});

// Motor falso: as vozes aparecem na hora ou só depois do evento `voiceschanged`.
function motor(inicial: VozLike[]) {
  let vozes = inicial;
  const ouvintes = new Set<() => void>();
  const sintese: SinteseLike = {
    speak: (_f: FalaLike) => {},
    cancel: () => {},
    getVoices: () => vozes,
    addEventListener: (_t, o) => void ouvintes.add(o),
    removeEventListener: (_t, o) => void ouvintes.delete(o),
  };
  return {
    sintese,
    chegam(novas: VozLike[]) {
      vozes = novas;
      for (const o of [...ouvintes]) o();
    },
    ouvintes,
  };
}

function guardaFalsa(
  inicial: Record<string, string> = {},
): ArmazenamentoLike & { dados: Map<string, string> } {
  const dados = new Map(Object.entries(inicial));
  return {
    dados,
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => void dados.set(k, v),
  };
}

describe("escolherVoz", () => {
  it("prefere pt-BR a qualquer outra, com a voz do aparelho antes da de rede", async () => {
    const m = motor([
      voz("Rede BR", "pt-BR", false),
      voz("Portugal", "pt-PT"),
      voz("Local BR", "pt-BR", true),
      voz("Inglesa", "en-US"),
    ]);
    const r = await escolherVoz(m.sintese, { armazenamento: guardaFalsa() });
    expect(r).toMatchObject({ tipo: "voz", portugal: false });
    expect(r.tipo === "voz" && r.voz.name).toBe("Local BR");
  });

  it("aceita pt_BR com sublinhado e caixa diferente", async () => {
    for (const lang of ["pt_BR", "PT-br", "pt_br", "por-BRA"]) {
      const m = motor([voz("V", lang)]);
      const r = await escolherVoz(m.sintese, { armazenamento: guardaFalsa() });
      expect(r, lang).toMatchObject({ tipo: "voz", portugal: false });
    }
  });

  it("só pt-PT: funciona e leva o aviso do sotaque", async () => {
    for (const lang of ["pt-PT", "pt_PT"]) {
      const m = motor([voz("Joana", lang), voz("Inglesa", "en-GB")]);
      const r = await escolherVoz(m.sintese, { armazenamento: guardaFalsa() });
      expect(r, lang).toMatchObject({ tipo: "voz", portugal: true });
    }
  });

  it("pt sem região e pt-AO contam como português sem o aviso de Portugal", async () => {
    for (const lang of ["pt", "pt-AO"]) {
      const m = motor([voz("V", lang)]);
      const r = await escolherVoz(m.sintese, { armazenamento: guardaFalsa() });
      expect(r, lang).toMatchObject({ tipo: "voz", portugal: false });
    }
  });

  it("não confunde 'p' ou 'portugues' inventado com português: só pt, pt-* e por-*", async () => {
    const m = motor([voz("A", "es-ES"), voz("B", "ptx"), voz("C", "en-US")]);
    vi.useFakeTimers();
    const p = escolherVoz(m.sintese, { armazenamento: guardaFalsa(), esperaMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    expect(await p).toEqual({ tipo: "sem-voz" });
  });

  it("sem a API: sem-suporte, sem esperar", async () => {
    expect(await escolherVoz(null)).toEqual({ tipo: "sem-suporte" });
    expect(await escolherVoz(undefined)).toEqual({ tipo: "sem-suporte" });
    expect(await escolherVoz({} as SinteseLike)).toEqual({ tipo: "sem-suporte" });
  });

  describe("espera pelas vozes", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sem voz nenhuma: espera 2 s, avisa que está procurando e termina em sem-voz", async () => {
      const m = motor([]);
      const aoEsperar = vi.fn();
      let resultado: unknown = null;
      void escolherVoz(m.sintese, { armazenamento: guardaFalsa(), aoEsperar }).then((r) => {
        resultado = r;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(aoEsperar).toHaveBeenCalledTimes(1);
      expect(resultado).toBeNull();
      expect(m.ouvintes.size).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(resultado).toEqual({ tipo: "sem-voz" });
      // O ouvinte do evento foi retirado: nada vaza.
      expect(m.ouvintes.size).toBe(0);
    });

    it("as vozes chegam antes dos 2 s: escolhe na hora, sem esperar o resto", async () => {
      const m = motor([]);
      let resultado: Awaited<ReturnType<typeof escolherVoz>> | null = null;
      void escolherVoz(m.sintese, { armazenamento: guardaFalsa() }).then((r) => {
        resultado = r;
      });
      await vi.advanceTimersByTimeAsync(300);
      m.chegam([voz("Marcia", "pt-BR")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultado).toMatchObject({ tipo: "voz" });
    });

    it("evento com vozes que não são português não encerra a espera", async () => {
      const m = motor([]);
      let resultado: Awaited<ReturnType<typeof escolherVoz>> | null = null;
      void escolherVoz(m.sintese, { armazenamento: guardaFalsa() }).then((r) => {
        resultado = r;
      });
      await vi.advanceTimersByTimeAsync(100);
      m.chegam([voz("Inglesa", "en-US")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultado).toBeNull();
      m.chegam([voz("Inglesa", "en-US"), voz("Lucia", "pt-BR")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultado).toMatchObject({ tipo: "voz" });
    });
  });

  describe("lembra a escolha", () => {
    it("grava a voz escolhida e a reusa na visita seguinte", async () => {
      const guarda = guardaFalsa();
      const m1 = motor([voz("Local BR", "pt-BR"), voz("Outra BR", "pt-BR")]);
      await escolherVoz(m1.sintese, { armazenamento: guarda });
      expect(guarda.dados.get(CHAVE_DA_VOZ)).toBe("Local BR");
      guarda.dados.set(CHAVE_DA_VOZ, "Outra BR");
      const r = await escolherVoz(m1.sintese, { armazenamento: guarda });
      expect(r.tipo === "voz" && r.voz.name).toBe("Outra BR");
    });

    it("valor lembrado inválido (voz que não existe ou não é português) é ignorado", async () => {
      for (const lembrado of ["Fantasma", "Inglesa", "<script>", ""]) {
        const guarda = guardaFalsa({ [CHAVE_DA_VOZ]: lembrado });
        const m = motor([voz("Local BR", "pt-BR"), voz("Inglesa", "en-US")]);
        const r = await escolherVoz(m.sintese, { armazenamento: guarda });
        expect(r.tipo === "voz" && r.voz.name, lembrado).toBe("Local BR");
      }
    });

    it("armazenamento que lança erro não derruba a escolha", async () => {
      const quebrado: ArmazenamentoLike = {
        getItem: () => {
          throw new Error("negado");
        },
        setItem: () => {
          throw new Error("negado");
        },
      };
      const m = motor([voz("Local BR", "pt-BR")]);
      expect(await escolherVoz(m.sintese, { armazenamento: quebrado })).toMatchObject({
        tipo: "voz",
      });
    });
  });
});
