# Avisos e atribuições

## Divisão das licenças

| Parte | Licença | Arquivo |
|-------|---------|---------|
| Código (tudo fora de `content/`) | MIT | `LICENSE` |
| Conteúdo escrito para este projeto (`content/`) | Creative Commons Atribuição-CompartilhaIgual 4.0 Internacional (CC BY-SA 4.0) | `content/LICENSE` |

O texto legal de `content/LICENSE` é o "legalcode" oficial da CC BY-SA 4.0, obtido em
<https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt>.
SHA-256 do arquivo: `28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5`.

## Texto bíblico: Bíblia Livre (BLIVRE)

Todas as Escrituras em português citadas são da Bíblia Livre (BLIVRE), Copyright © Diego Santos, Mario Sérgio, e Marco Teles, http://sites.google.com/site/biblialivre/ - fevereiro de 2018. Licença Creative Commons Atribuição 3.0 Brasil (http://creativecommons.org/licenses/by/3.0/br/). Reprodução permitida desde que devidamente mencionados fonte e autores.

Uso livre com atribuição obrigatória, sob a licença "Creative Commons Atribuição 3.0 Brasil".

### Alterações feitas no texto

A licença exige indicar as mudanças. A marcação do texto de origem foi lida por um programa
(os identificadores de versículo, as marcas de aspas `«»` e as notas de rodapé foram tratados) e
o resultado foi carregado em um banco de dados. O texto das palavras não foi reescrito.
Um versículo (Marcos 5:19) aparece unido ao anterior na fonte e é tratado como exceção
registrada.

O texto da Bíblia Livre **não** está coberto pela licença MIT nem pela CC BY-SA 4.0 deste
repositório: segue a licença original acima.

## Textos de Fontes do Acervo: `data/acervo-derivados/` e `tests/fixtures/acervo/`

Os arquivos de `data/acervo-derivados/` são **texto de terceiros**, já interpretado por um programa a partir
da edição de origem (notas de editor e marcação de edição retiradas; o texto das palavras não foi reescrito).
Cada um segue a licença da própria origem, que fica registrada em `data/acervo-origens.yaml` e na página de
créditos do site: domínio público, ou CC BY-SA 4.0 na edição digital do Perseus. Esses arquivos **não** estão
sob a licença MIT do código nem sob a CC BY-SA 4.0 de `content/`.

### Perseus Digital Library: *Antiquities of the Jews*, de Flávio Josefo (recorte de teste)

`tests/fixtures/acervo/derivados/josefo-antiguidades.json` reproduz dois parágrafos (18.63 e 20.197, com as
notas do editor retiradas) da tradução inglesa de William Whiston, tal como a edição digital do Perseus
Digital Library (Universidade de Tufts, <https://www.perseus.tufts.edu/>) a publica em
`tlg0526.tlg001.perseus-eng2.xml`, commit `dacb04909e43dc47738828d33cc3d2b0635bc54c` de
<https://github.com/PerseusDL/canonical-greekLit>. Edição digital sob a licença Creative Commons
Atribuição-CompartilhaIgual 4.0 Internacional (<https://creativecommons.org/licenses/by-sa/4.0/>); a tradução
de Whiston é de domínio público. Alteração feita: remoção das notas do editor e da marcação, e junção das
linhas de cada parágrafo.

### Perseus Digital Library: fixture do leitor TEI (`tests/fixtures/acervo/perseus-josefo-trecho.xml`)

Recorte do arquivo `tlg0526.tlg001.perseus-eng2.xml` (*Antiquities of the Jews*, tradução de William Whiston,
edição de Alden and Beardsley, 1856), commit `dacb04909e43dc47738828d33cc3d2b0635bc54c` de
<https://github.com/PerseusDL/canonical-greekLit>: o cabeçalho TEI inteiro e quatro unidades do texto (18.63,
18.65, 20.197 e 20.204), sem nenhuma alteração. Edição digital: Perseus Digital Library, Universidade de Tufts
(<https://www.perseus.tufts.edu/>), sob a licença Creative Commons Atribuição-CompartilhaIgual
(<https://creativecommons.org/licenses/by-sa/4.0/>). Serve de entrada de teste do leitor; o arquivo completo é
baixado só na máquina de quem desenvolve e nunca entra no repositório.

### Perseus Digital Library: fixtures de Luciano e de Tácito (`tests/fixtures/acervo/perseus-luciano-*.xml`, `perseus-tacito-trecho.xml`)

Recortes de teste do leitor TEI e do verificador de licença, sem nenhuma alteração do texto, de arquivos do
Perseus Digital Library (Universidade de Tufts, <https://www.perseus.tufts.edu/>), edição digital sob a licença
Creative Commons Atribuição-CompartilhaIgual (<https://creativecommons.org/licenses/by-sa/4.0/>):

- `perseus-luciano-eng4-trecho.xml`: o cabeçalho TEI inteiro e as seções 11 a 13 de `tlg0062.tlg042.perseus-eng4.xml`
  (*The Death of Peregrine*, de Luciano, tradução de Henry Watson Fowler e Francis George Fowler, Clarendon Press,
  1905), commit `dacb04909e43dc47738828d33cc3d2b0635bc54c` de <https://github.com/PerseusDL/canonical-greekLit>.
  A tradução é de domínio público.
- `perseus-luciano-eng2-cabecalho.xml`: **só o cabeçalho TEI** de `tlg0062.tlg042.perseus-eng2.xml`, mesmo commit. É
  a tradução de Austin Morris Harmon (Loeb, 1936), **protegida por direitos autorais** apesar de o cabeçalho dizer
  CC BY-SA; o arquivo existe só como controle negativo do verificador, que o reprova pelo tradutor. Nenhum trecho
  da tradução de Harmon está no repositório.
- `perseus-tacito-trecho.xml`: o cabeçalho TEI inteiro e os capítulos 43 a 45 do livro 15 de
  `phi1351.phi005.perseus-eng2.xml` (*The Annals*, de Tácito, tradução de Alfred John Church e William Jackson
  Brodribb, Macmillan, 1869), commit `8cef51623130f2412da410858e32c322eb796c0a` de
  <https://github.com/PerseusDL/canonical-latinLit>. A tradução de 1869 é de domínio público; o cabeçalho avisa
  que o texto parece seguir a reimpressão de 1942, e por isso o Tácito completo **não** é publicado até a conferência
  contra a edição de 1895.
