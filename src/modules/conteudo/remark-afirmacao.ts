// Plugin do react-markdown (TRIL-07): transforma a diretiva `:afirmacao[frase]{#id}` num elemento
// conhecido e, ao fim de cada parágrafo (ou item de lista) que contém Afirmação, acrescenta um
// marcador por Afirmação, que o componente troca pelo chip "Fonte em preparação". Com mais de uma
// Afirmação no bloco, cada chip e cada frase levam o mesmo ordinal (a frase em `sup`).
//
// Há um segundo trabalho, e é o que impede um defeito real: o remark-directive lê como diretiva de
// texto qualquer ":nome" sem letra ou dígito antes do nome, então o "3:13" de "Mt 3:13" chega aqui
// como a diretiva "13". Sem tratamento, o react-markdown a descartaria e a página mostraria "Mt 3".
// Toda diretiva que não é `afirmacao` volta a ser o texto exato do arquivo.
//
// Sem HTML cru: os elementos criados são só `span` e `sup`; a diretiva nunca vira marcação livre.

type No = {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: No[];
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, string> };
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const marcador = (ordinal: number | null): No => ({
  type: "textDirective",
  name: "chip",
  attributes: {},
  children: [],
  data: {
    hName: "span",
    hProperties: {
      dataChipFonte: "1",
      ...(ordinal !== null ? { dataOrdinal: String(ordinal) } : {}),
    },
  },
});

const ordinalSobrescrito = (ordinal: number): No => ({
  type: "textDirective",
  name: "ordinal",
  attributes: {},
  children: [{ type: "text", value: String(ordinal) }],
  data: { hName: "sup", hProperties: { dataOrdinal: String(ordinal) } },
});

export function remarkAfirmacao() {
  return (arvore: unknown, arquivo: { value?: unknown }): void => {
    const fonte = typeof arquivo.value === "string" ? arquivo.value : "";

    const passar = (no: No): void => {
      if (!no.children) return;
      no.children = no.children.map((filho) => {
        if (filho.type === "textDirective" && filho.name !== "afirmacao") {
          const de = filho.position?.start.offset;
          const ate = filho.position?.end.offset;
          // O texto original do arquivo, sem mexer em nada: ":13" continua sendo ":13".
          if (de !== undefined && ate !== undefined)
            return { type: "text", value: fonte.slice(de, ate) } satisfies No;
          return { type: "text", value: `:${filho.name ?? ""}` } satisfies No;
        }
        return filho;
      });
      for (const filho of no.children) passar(filho);
    };

    const marcar = (no: No): void => {
      if (no.type === "paragraph") {
        const doBloco: No[] = [];
        const achar = (n: No): void => {
          for (const f of n.children ?? []) {
            if (f.type === "textDirective" && f.name === "afirmacao") doBloco.push(f);
            else achar(f);
          }
        };
        achar(no);
        doBloco.forEach((a, i) => {
          a.data = { hName: "span", hProperties: { dataAfirmacaoId: a.attributes?.id ?? "" } };
          if (doBloco.length > 1) a.children = [...(a.children ?? []), ordinalSobrescrito(i + 1)];
        });
        doBloco.forEach((_, i) => {
          no.children = [...(no.children ?? []), marcador(doBloco.length > 1 ? i + 1 : null)];
        });
        return;
      }
      for (const f of no.children ?? []) marcar(f);
    };

    const raiz = arvore as No;
    passar(raiz);
    marcar(raiz);
  };
}
