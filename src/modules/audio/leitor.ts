import {
  type EscolhaDeVoz,
  escolherVoz,
  type FalaLike,
  type OpcoesDaEscolha,
  type SinteseLike,
  type VozLike,
} from "./vozes";

// Leitor em voz do Estudo e do texto bíblico (AUD-01 a AUD-04, D-13). Máquina de estados pura, sem
// React e sem navegador: recebe a API de fala por uma função (o teste entrega um falso) e nunca fala
// sozinha, só depois de `iniciar`, chamado no toque da pessoa.
//
// Decisão da pesquisa: pausar CANCELA e lembra o trecho; continuar recomeça desse trecho. É o
// mesmo comportamento em todo aparelho, porque no Android pausar equivale a cancelar.

export type EstadoDoLeitor =
  | "ocioso"
  | "procurando"
  | "lendo"
  | "pausado"
  | "sem-voz"
  | "sem-suporte"
  | "falha";

export type Instantaneo = Readonly<{
  estado: EstadoDoLeitor;
  /** Quem está lendo ou parou de ler (o id do controle); `null` quando ninguém. */
  dono: string | null;
  /** Índice do trecho em fala (ou onde a leitura recomeça, se pausada). */
  trecho: number;
  total: number;
  /** A voz escolhida é de Portugal: o sotaque pode soar diferente. */
  avisoPortugal: boolean;
}>;

export const INSTANTANEO_INICIAL: Instantaneo = {
  estado: "ocioso",
  dono: null,
  trecho: 0,
  total: 0,
  avisoPortugal: false,
};

export type DependenciasDoLeitor = {
  /** A API de fala do aparelho, pedida só na hora de usar (no servidor ela não existe). */
  sintese: () => SinteseLike | null | undefined;
  /** Cria uma fala com o texto dado (`new SpeechSynthesisUtterance`). */
  criarFala: (texto: string) => FalaLike;
  opcoesDaEscolha?: OpcoesDaEscolha;
};

// Erros que o motor dispara quando a própria leitura cancela ou interrompe a fila: não são falha.
const ERROS_DE_CANCELAMENTO = new Set(["canceled", "cancelled", "interrupted"]);

export class LeitorEmVoz {
  private atual: Instantaneo = INSTANTANEO_INICIAL;
  private readonly ouvintes = new Set<() => void>();
  private voz: VozLike | null = null;
  private trechos: string[] = [];
  private geracao = 0;
  // O Chrome pode recolher falas sem referência antes de elas terminarem: o leitor as mantém.
  private falas: FalaLike[] = [];
  private preparacao: Promise<void> | null = null;

  constructor(private readonly dependencias: DependenciasDoLeitor) {}

  /** Para `useSyncExternalStore`: a identidade só muda quando o estado muda. */
  instantaneo = (): Instantaneo => this.atual;

  assinar = (ouvinte: () => void): (() => void) => {
    this.ouvintes.add(ouvinte);
    return () => {
      this.ouvintes.delete(ouvinte);
    };
  };

  private mudar(parte: Partial<Instantaneo>): void {
    this.atual = { ...this.atual, ...parte };
    for (const ouvinte of this.ouvintes) ouvinte();
  }

  /**
   * Procura a voz em português (até 2 s) e deixa o leitor pronto, ou em `sem-voz` ou `sem-suporte`.
   * Roda uma vez; chamadas seguintes devolvem a mesma promessa. Não fala nada.
   */
  preparar(): Promise<void> {
    if (!this.preparacao) {
      this.preparacao = this.procurar();
    }
    return this.preparacao;
  }

  private async procurar(): Promise<void> {
    const escolha: EscolhaDeVoz = await escolherVoz(this.dependencias.sintese(), {
      ...this.dependencias.opcoesDaEscolha,
      aoEsperar: () => {
        if (this.atual.estado === "ocioso") this.mudar({ estado: "procurando" });
        this.dependencias.opcoesDaEscolha?.aoEsperar?.();
      },
    });
    if (escolha.tipo === "voz") {
      this.voz = escolha.voz;
      this.mudar({
        avisoPortugal: escolha.portugal,
        ...(this.atual.estado === "procurando" ? { estado: "ocioso" as const } : {}),
      });
    } else {
      this.mudar({ estado: escolha.tipo, dono: null });
    }
  }

  /**
   * Enfileira todos os trechos de uma vez, no toque (gesto da pessoa), e acompanha o progresso pelo
   * evento `start` de cada fala. Se outro controle está lendo, interrompe a leitura dele.
   * Devolve `false` quando não pode começar (procurando voz, sem voz, sem suporte, sem texto).
   */
  iniciar(trechos: readonly string[], dono: string): boolean {
    const { estado } = this.atual;
    const pronto =
      estado === "ocioso" || estado === "lendo" || estado === "pausado" || estado === "falha";
    if (!pronto || !this.voz || trechos.length === 0) return false;
    this.trechos = [...trechos];
    this.mudar({ dono, total: this.trechos.length, trecho: 0 });
    this.enfileirarDe(0);
    return true;
  }

  /** Cancela e lembra o trecho em fala. */
  pausar(): void {
    if (this.atual.estado !== "lendo") return;
    this.geracao++;
    this.cancelarNoMotor();
    this.mudar({ estado: "pausado" });
  }

  /** Recomeça do trecho em que a leitura foi pausada. */
  continuar(): void {
    if (this.atual.estado !== "pausado" || !this.voz) return;
    this.enfileirarDe(this.atual.trecho);
  }

  /** Cancela e volta a ocioso. Não faz nada se o leitor não está lendo, pausado ou em falha. */
  parar(): void {
    const { estado } = this.atual;
    if (estado !== "lendo" && estado !== "pausado" && estado !== "falha") return;
    this.geracao++;
    this.cancelarNoMotor();
    this.falas = [];
    this.mudar({ estado: "ocioso", dono: null, trecho: 0, total: 0 });
  }

  private cancelarNoMotor(): void {
    this.dependencias.sintese()?.cancel();
  }

  private enfileirarDe(inicio: number): void {
    const sintese = this.dependencias.sintese();
    const voz = this.voz;
    if (!sintese || !voz) return;
    // Cada enfileiramento é uma geração: eventos de falas que o cancelamento deixou para trás não
    // mexem no estado.
    const geracao = ++this.geracao;
    sintese.cancel();
    this.falas = [];
    this.mudar({ estado: "lendo", trecho: inicio });
    const ultimo = this.trechos.length - 1;
    for (let i = inicio; i <= ultimo; i++) {
      const fala = this.dependencias.criarFala(this.trechos[i] as string);
      fala.lang = voz.lang;
      fala.voice = voz;
      fala.onstart = () => {
        if (geracao === this.geracao) this.mudar({ estado: "lendo", trecho: i });
      };
      fala.onend = () => {
        if (geracao !== this.geracao || i !== ultimo) return;
        this.falas = [];
        this.mudar({ estado: "ocioso", dono: null, trecho: 0, total: 0 });
      };
      fala.onerror = (evento) => {
        if (geracao !== this.geracao) return;
        if (evento?.error && ERROS_DE_CANCELAMENTO.has(evento.error)) return;
        this.falhar();
      };
      this.falas.push(fala);
      try {
        sintese.speak(fala);
      } catch {
        this.falhar();
        return;
      }
    }
  }

  private falhar(): void {
    this.geracao++;
    this.cancelarNoMotor();
    this.falas = [];
    this.mudar({ estado: "falha" });
  }
}
