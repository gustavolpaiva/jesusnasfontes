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
