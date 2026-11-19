# Bíblia Livre: completude e comparação com o texto do protótipo

Relatório gerado por `scripts/ingest/comparar-artifact.ts`. Não tem data nem caminho local: rodar de novo sobre os mesmos arquivos dá o mesmo texto.

## Fonte

- Bíblia Livre (BLIVRE), commit `a315a15e9f4d01883b62206fe441d57762f126b3`, edições n4 (Novo Testamento pelo texto crítico de Nestle 1904) e tr (Textus Receptus).
- Impressão do que foi interpretado (as duas edições): `65588d2d2ab957415346857875327353c59f44c4489861c02e0e7c699f5d82cd`. É a mesma que `pnpm ingest:verify --impressao` imprime.
- Arquivo do protótipo lido: evangelhos.json, sha256 `71939ff890ea08a0e22f7bcf9e7051d5e66515e94a9234ad95a62d794a6e4f38`.

## Completude contra o esperado

Esperado de cada edição: 31101 versículos (31101 ids), 1189 capítulos e 66 livros. O esperado por livro é a soma do último versículo de cada capítulo, menos os versículos mesclados nomeados abaixo.

| Edição | Versículos lidos | Esperado | Capítulos lidos | Esperado | Situação |
|---|---|---|---|---|---|
| n4 | 31101 | 31101 | 1189 | 1189 | completa |
| tr | 31101 | 31101 | 1189 | 1189 | completa |

Exceções nomeadas (qualquer outra falta reprova a verificação):

- Mc 5:19 não tem id próprio nas duas edições: o texto está dentro de Mc 5:18. A chave do versículo existe no banco e a correspondência de versificação a liga ao marcador do arquivo-fonte, sem linha de texto. Por isso cada edição tem 31101 linhas de texto e o banco tem 31102 chaves de versículo.
- At 28:29 na edição tr: o arquivo-fonte traz o id e nenhum texto (só uma nota). A linha existe, vazia, e conta nos 31101.

### Por livro

| Livro | Esperado | n4 | tr |
|---|---|---|---|
| Gênesis | 1533 | 1533 | 1533 |
| Êxodo | 1213 | 1213 | 1213 |
| Levítico | 859 | 859 | 859 |
| Números | 1288 | 1288 | 1288 |
| Deuteronômio | 959 | 959 | 959 |
| Josué | 658 | 658 | 658 |
| Juízes | 618 | 618 | 618 |
| Rute | 85 | 85 | 85 |
| 1 Samuel | 810 | 810 | 810 |
| 2 Samuel | 695 | 695 | 695 |
| 1 Reis | 816 | 816 | 816 |
| 2 Reis | 719 | 719 | 719 |
| 1 Crônicas | 942 | 942 | 942 |
| 2 Crônicas | 822 | 822 | 822 |
| Esdras | 280 | 280 | 280 |
| Neemias | 406 | 406 | 406 |
| Ester | 167 | 167 | 167 |
| Jó | 1070 | 1070 | 1070 |
| Salmos | 2461 | 2461 | 2461 |
| Provérbios | 915 | 915 | 915 |
| Eclesiastes | 222 | 222 | 222 |
| Cantares | 117 | 117 | 117 |
| Isaías | 1292 | 1292 | 1292 |
| Jeremias | 1364 | 1364 | 1364 |
| Lamentações | 154 | 154 | 154 |
| Ezequiel | 1273 | 1273 | 1273 |
| Daniel | 357 | 357 | 357 |
| Oseias | 197 | 197 | 197 |
| Joel | 73 | 73 | 73 |
| Amós | 146 | 146 | 146 |
| Obadias | 21 | 21 | 21 |
| Jonas | 48 | 48 | 48 |
| Miqueias | 105 | 105 | 105 |
| Naum | 47 | 47 | 47 |
| Habacuque | 56 | 56 | 56 |
| Sofonias | 53 | 53 | 53 |
| Ageu | 38 | 38 | 38 |
| Zacarias | 211 | 211 | 211 |
| Malaquias | 55 | 55 | 55 |
| Mateus | 1071 | 1071 | 1071 |
| Marcos | 677 | 677 | 677 |
| Lucas | 1151 | 1151 | 1151 |
| João | 879 | 879 | 879 |
| Atos | 1007 | 1007 | 1007 |
| Romanos | 433 | 433 | 433 |
| 1 Coríntios | 437 | 437 | 437 |
| 2 Coríntios | 257 | 257 | 257 |
| Gálatas | 149 | 149 | 149 |
| Efésios | 155 | 155 | 155 |
| Filipenses | 104 | 104 | 104 |
| Colossenses | 95 | 95 | 95 |
| 1 Tessalonicenses | 89 | 89 | 89 |
| 2 Tessalonicenses | 47 | 47 | 47 |
| 1 Timóteo | 113 | 113 | 113 |
| 2 Timóteo | 83 | 83 | 83 |
| Tito | 46 | 46 | 46 |
| Filemom | 25 | 25 | 25 |
| Hebreus | 303 | 303 | 303 |
| Tiago | 108 | 108 | 108 |
| 1 Pedro | 105 | 105 | 105 |
| 2 Pedro | 61 | 61 | 61 |
| 1 João | 105 | 105 | 105 |
| 2 João | 13 | 13 | 13 |
| 3 João | 14 | 14 | 14 |
| Judas | 25 | 25 | 25 |
| Apocalipse | 404 | 404 | 404 |

Nenhum livro difere do esperado, em nenhuma das duas edições.

## Comparação com o texto do protótipo (evangelhos.json)

O protótipo tem 3779 versículos nos quatro evangelhos e 58 em 1 Coríntios 15; a Bíblia Livre tem 3778 ids nos evangelhos. A diferença de um é Marcos 5:19, que o protótipo separa e a Bíblia Livre traz dentro de 5:18: esse par é comparado inteiro com 5:18, uma vez.

Comparação exata: o texto do protótipo e o da edição são iguais depois de normalizar (NFC, espaços repetidos viram um, sem « », sem marcas de nota). Nada além disso é relevado.

| Livro | Versículos no protótipo | Comparados | Batem com n4 | Batem com tr | Batem com as duas |
|---|---|---|---|---|---|
| Mt | 1071 | 1071 | 94 | 88 | 87 |
| Mc | 678 | 677 | 32 | 26 | 26 |
| Lc | 1151 | 1151 | 97 | 93 | 91 |
| Jo | 879 | 879 | 29 | 29 | 29 |
| 1Co | 58 | 58 | 51 | 51 | 51 |
| Quatro evangelhos | 3779 | 3778 | 252 | 236 | 233 |
| Todos | 3837 | 3836 | 303 | 287 | 284 |

Em 7,9% dos versículos comparados o protótipo é igual à n4 e em 7,5% é igual à tr.
Pela sobreposição de palavras (acentos mantidos, sem pontuação nem maiúsculas) o protótipo está em média a 79,5% da n4 e a 78,5% da tr; a n4 é a mais próxima em 386 versículos, a tr em 76 e há empate em 3374.

### Cada versículo que difere de alguma edição, com a explicação

Fora das listas ficam só os 284 versículos que batem exatamente com as duas edições. Cada versículo aparece em uma lista só.

#### so-n4: 19 versículo(s)

as duas edições diferem entre si neste versículo (variante textual) e o artifact segue a n4

Mt 1:6; Mt 5:44; Mt 12:8; Mt 16:20; Mt 26:59; Mt 27:2; Mt 28:20; Mc 2:20; Mc 4:28; Mc 6:44; Mc 10:6; Mc 14:2; Mc 15:23; Lc 2:33; Lc 4:2; Lc 6:16; Lc 9:56; Lc 11:11; Lc 22:62

#### so-tr: 3 versículo(s)

as duas edições diferem entre si neste versículo (variante textual) e o artifact segue a tr

Mt 21:14; Lc 6:25; Lc 7:31

#### quase: 240 versículo(s)

só pontuação, maiúscula ou aspas separam o artifact de pelo menos uma edição (as palavras são as mesmas)

Mt 1:18, 21, 23, 25; Mt 2:5, 11, 13; Mt 3:1, 10; Mt 4:1, 7, 9, 13, 17, 19; Mt 5:14; Mt 6:15; Mt 7:12, 20; Mt 8:2, 7, 27; Mt 9:15, 34, 38; Mt 10:34-36, 42; Mt 11:5, 15, 21, 24; Mt 12:7, 35, 47; Mt 13:9, 37, 43; Mt 14:24, 28; Mt 15:16; Mt 16:15, 28; Mt 18:20; Mt 19:10, 14; Mt 20:16, 18; Mt 21:1; Mt 22:32, 36, 38, 40; Mt 23:19-21, 26; Mt 24:5, 9, 16; Mt 25:39; Mt 26:2, 5, 32, 74; Mt 27:10, 22, 43, 57; Mc 1:1, 24, 41; Mc 2:28; Mc 3:8, 18, 35; Mc 4:9, 23; Mc 5:1, 12; Mc 6:15; Mc 7:2, 20, 23; Mc 8:2, 12; Mc 9:23, 43, 49; Mc 10:28, 31, 33, 48; Mc 11:12; Mc 12:7, 29, 32, 39; Mc 13:6, 17, 22, 37; Mc 14:25, 38, 46; Mc 15:3, 22, 30, 32, 38; Mc 16:15; Lc 1:11, 15, 30, 38, 55, 59, 71, 75; Lc 2:10-14, 24, 28; Lc 3:9, 13, 26, 29-32, 35, 37; Lc 4:7, 10, 36, 43-44; Lc 5:21, 32-33, 36, 38-39; Lc 6:5, 49; Lc 7:11; Lc 8:26, 52; Lc 9:27, 32, 35; Lc 10:12, 36; Lc 11:23, 39; Lc 12:53; Lc 13:19-20; Lc 14:17, 22, 30, 34; Lc 15:7, 11, 21, 24, 26, 30-31; Lc 17:10, 13-14, 26; Lc 18:1, 33, 36, 41-42; Lc 19:9, 13, 16, 18, 38; Lc 20:4, 22, 24, 30, 39; Lc 21:3, 21, 29, 32; Lc 22:9, 70-71; Lc 23:4, 12, 37, 39, 44-45; Lc 24:34, 53; Jo 1:28, 49; Jo 2:5; Jo 3:5, 23-24, 27; Jo 4:3, 20, 31; Jo 6:25, 58, 69; Jo 7:34; Jo 8:23, 32, 46; Jo 9:2, 10, 14; Jo 10:1, 8, 30; Jo 11:10, 21-22; Jo 13:35; Jo 15:14; Jo 16:11; Jo 17:9; Jo 18:30; Jo 20:22; 1Co 15:45

#### mesclado: 1 versículo(s)

Mc 5:18 e 5:19: a Bíblia Livre traz o texto dos dois no id de 5:18 (o par é comparado inteiro com 5:18); o artifact os separa

Mc 5:18-19

#### variante: 452 versículo(s)

as duas edições diferem entre si e nenhuma coincide com o artifact (variante textual somada à redação)

Mt 2:18; Mt 3:6-8, 11, 16; Mt 4:3; Mt 5:22, 25, 27, 30, 47-48; Mt 6:1, 4-6, 18, 21, 33; Mt 7:15, 24, 29; Mt 8:10, 13, 15, 18, 21, 25, 28-29, 31-32; Mt 9:8, 12-14, 24, 32, 35-36; Mt 10:3, 8; Mt 11:2, 16, 19, 23; Mt 12:4, 15, 22, 25, 31, 38; Mt 13:11, 35, 51; Mt 14:6, 15, 22, 25, 30; Mt 15:1, 4, 6, 8, 12, 15, 17, 22, 30, 33, 36, 39; Mt 16:3-5, 8, 13, 19, 21, 26; Mt 17:4, 10, 20, 26; Mt 18:8, 15, 19, 26, 29, 35; Mt 19:3-4, 9, 16-17, 19-20, 24-25, 29; Mt 20:6-7, 17, 19, 22-23; Mt 21:4, 7, 12-13; Mt 22:7, 10, 27, 30, 44; Mt 23:3-4, 7-8, 17; Mt 24:6-7, 17-18, 31, 36, 42; Mt 25:2, 6, 13, 15, 31, 44; Mt 26:3, 8-9, 20, 28, 43-45, 53, 55, 60, 63, 65; Mt 27:24, 34-35, 41, 58, 64; Mt 28:2, 6, 9; Mc 1:2, 5, 8, 11, 13-14, 18-19, 23, 31, 39-40, 42; Mc 2:2-3, 7, 16-17, 22; Mc 3:5, 15, 29, 31-33; Mc 4:4, 10-12, 15, 19, 24, 36; Mc 5:5, 11, 13-14, 22, 25, 36, 38, 40, 42; Mc 6:11, 14, 16, 20, 33, 36, 41, 51-52; Mc 7:4-5, 8, 21-22, 24-25, 30-31; Mc 8:1, 17, 20-23, 25-26, 34; Mc 9:3, 14, 16-17, 19, 24, 29, 45; Mc 10:7, 10, 12-13, 21, 24, 29, 34-35, 38, 40, 46, 49; Mc 11:8, 10, 14, 18, 23, 28; Mc 12:4, 19-20, 22-23, 30-31, 33, 36, 38, 41; Mc 13:5, 7-9, 11, 14-15, 18, 23, 27, 33; Mc 14:5, 9, 16, 19, 21-22, 24, 27, 40, 43, 45, 51-53, 65, 68-70, 72; Mc 15:4, 8, 12, 28, 39; Lc 1:28-29, 35, 66, 74, 78; Lc 2:9, 21-22, 37-38, 40, 42-43; Lc 3:4, 17, 19, 22, 27, 33; Lc 4:1, 4-5, 8-9, 18, 33-34, 41; Lc 5:5-6, 15, 17, 20, 30, 34; Lc 6:1-2, 4, 6, 9-10, 18, 33-34, 36, 39-40, 45, 48; Lc 7:6-7, 10, 19, 21, 28, 32, 42, 44; Lc 8:3, 12, 27, 29, 45, 48, 54; Lc 9:50, 54-55; Lc 10:11, 15, 35, 42; Lc 11:2, 4, 29, 44, 53-54; Lc 12:7, 23, 39, 56; Lc 13:18, 31; Lc 14:3, 5, 10; Lc 15:17, 22; Lc 17:9; Lc 19:42; Lc 20:5, 13, 23; Lc 21:8, 15; Lc 22:30-31, 37, 39, 64, 68; Lc 23:15, 23; Lc 24:17, 42, 46; Jo 1:18, 27, 51; Jo 2:17; Jo 3:13, 15; Jo 5:16, 30; Jo 6:2, 22, 47, 65; Jo 7:8; Jo 8:38, 59; Jo 9:4, 9, 20, 35; Jo 10:19, 26, 29, 32, 38; Jo 11:41, 50; Jo 12:13; Jo 13:22; Jo 14:4, 12, 14-15; Jo 16:10, 16; Jo 17:1, 11-12, 17, 21; Jo 20:29; Jo 21:15-17, 25; 1Co 15:55

#### redacao: 2837 versículo(s)

as duas edições trazem o mesmo texto e o artifact usa outra redação em português para o mesmo versículo

Mt 1:20, 22, 24; Mt 2:2-3, 6, 8-10, 14-16, 19-20, 22-23; Mt 3:2-5, 9, 12-15, 17; Mt 4:2, 4-6, 8, 10, 12, 15-16, 18, 20-25; Mt 5:1-13, 15, 17-21, 24, 26, 28-29, 31-33, 35-43, 45-46; Mt 6:2-3, 7-8, 10, 12-14, 16-17, 19-20, 22-32, 34; Mt 7:2-4, 6, 8-9, 11, 13, 16-17, 21-23, 25-28; Mt 8:1, 3-6, 8-9, 11-12, 14, 16-17, 19-20, 22-24, 26, 30, 33-34; Mt 9:1-7, 9-11, 17-23, 25-31, 33, 37; Mt 10:1-2, 4-7, 10, 13-18, 20-21, 23, 25-29, 31-33, 41; Mt 11:1, 3-4, 6-12, 14, 17-18, 20, 25-27, 29-30; Mt 12:1-3, 5-6, 9-14, 16-21, 23-24, 26-29, 32-34, 36-37, 39-46, 48-50; Mt 13:1-8, 10, 13-17, 19-25, 27-34, 36, 39-41, 44-49, 52-54, 56-57; Mt 14:1-5, 7-14, 16-21, 23, 26-27, 29, 31, 33-36; Mt 15:2-3, 5, 9-11, 13-14, 18-21, 23-29, 31-32, 34-35, 37-38; Mt 16:1-2, 6-7, 9-12, 14, 16-18, 22-25, 27; Mt 17:1-2, 5-9, 11-19, 21-25, 27; Mt 18:1-7, 9-14, 16-17, 21-25, 27-28, 31-34; Mt 19:1-2, 5-8, 11-13, 15, 18, 21-23, 26-28; Mt 20:1-5, 8-15, 20-21, 24-34; Mt 21:2-3, 5-6, 9-11, 15-46; Mt 22:1-6, 8-9, 11-24, 26, 28-29, 31, 33-35, 37, 39, 42-43, 45-46; Mt 23:1-2, 5-6, 9-10, 13-16, 18, 22-23, 25, 27, 29-31, 33-39; Mt 24:1-4, 8, 10-11, 13, 15, 20, 22-24, 26-30, 32-33, 35, 37-41, 43-50; Mt 25:1, 3-5, 8-12, 14, 16-30, 32-38, 40-43, 45-46; Mt 26:1, 4, 6-7, 10-19, 21-27, 29-31, 33-42, 46-52, 54, 56-58, 61-62, 64, 66-73, 75; Mt 27:1, 4-9, 11-15, 17-21, 23, 25-33, 36-40, 42, 44-56, 59-60, 62-63, 65-66; Mt 28:1, 4-5, 7-8, 10-19; Mc 1:3-4, 6-7, 9-10, 15-17, 20-22, 25-30, 32-38, 43-45; Mc 2:1, 4-5, 8-15, 18-19, 21, 23-27; Mc 3:1-4, 6-7, 9-14, 16, 20-27, 34; Mc 4:1-3, 6, 8, 13, 16-18, 20-22, 25-27, 29-33, 35, 37-41; Mc 5:2-4, 6-10, 15-17, 20-21, 23-24, 26-31, 33-35, 37, 39, 41, 43; Mc 6:1-8, 10, 12-13, 17-19, 21-32, 34-35, 37-40, 42-43, 45-50, 53-56; Mc 7:1, 3, 6-7, 9-19, 27-29, 32-37; Mc 8:3-11, 13-16, 18-19, 24, 27-33, 35-38; Mc 9:1-2, 4-13, 15, 18, 20-22, 25-28, 30-39, 41-42, 44, 46-47, 50; Mc 10:1-5, 8-9, 11, 14-20, 22-23, 25-27, 30, 32, 36-37, 39, 41-45, 47, 50-52; Mc 11:1-7, 9, 11, 13, 15-17, 19-22, 24-27, 29-33; Mc 12:1, 3, 5-6, 8-18, 21, 24-28, 34-35, 37, 40, 42-44; Mc 13:1-4, 10, 12, 16, 19-21, 25-26, 28-32, 34-36; Mc 14:1, 3-4, 6-8, 11-15, 18, 20, 23, 26, 28-37, 39, 41, 44, 47-50, 54-58, 60-62, 66-67, 71; Mc 15:1-2, 5-7, 9-11, 13-21, 24-26, 29, 31, 33-37, 40-47; Mc 16:1-14, 17-20; Lc 1:2-5, 7-8, 10, 12-14, 16-20, 22, 24-26, 31, 33-34, 36-37, 39-48, 51, 53-54, 56-58, 60-65, 68-70, 72, 76-77, 79-80; Lc 2:1-2, 4-6, 8, 15-20, 26-27, 29-32, 34-36, 39, 46-49, 51-52; Lc 3:3, 5-8, 10-12, 14-16, 28; Lc 4:3, 6, 11-17, 19-32, 35, 38-40, 42; Lc 5:1-4, 7-14, 16, 18-19, 22-29, 31, 35, 37; Lc 6:3, 8, 11-12, 17, 19-23, 26-32, 35, 37-38, 42, 44, 46-47; Lc 7:1-5, 8-9, 13-18, 20, 22-27, 29-30, 33-39, 41, 43, 45-50; Lc 8:4-11, 13-25, 28, 35, 42-44, 46-47, 49-51, 55; Lc 9:1, 3-7, 9-25, 28-29, 31, 33-34, 36-39, 41, 43-49, 51-53, 58-62; Lc 10:1-10, 13, 16-34, 37-41; Lc 11:1, 3, 5-10, 12-22, 24-28, 30-38, 40-42, 45-46, 48-52; Lc 12:1-6, 8-9, 11-22, 24, 26-38, 40-52, 54-55, 58-59; Lc 13:1-12, 14-17, 21-30, 32-35; Lc 14:1-2, 4, 6-9, 11-16, 18-21, 23-29, 31-33, 35; Lc 15:1-3, 5-6, 8-10, 12-16, 18-20, 25, 27-29, 32; Lc 16:1-9, 11-31; Lc 17:1-8, 11-12, 15-25, 27-37; Lc 18:2-32, 34-35, 38-40, 43; Lc 19:1-5, 7-8, 10-12, 14-15, 17, 19-35, 37, 39-41, 43-48; Lc 20:1-3, 6, 8-12, 14-21, 25-29, 31, 33-38, 40-47; Lc 21:1, 4-7, 9-14, 16-20, 23-28, 30-31, 33-38; Lc 22:1-6, 8, 10-20, 22-29, 32-36, 38, 40-42, 44-61, 63, 66-67, 69; Lc 23:2-3, 5-11, 13-14, 16-22, 25-36, 38, 40-43, 46-51, 53-56; Lc 24:1, 4-16, 18-19, 21-33, 35-36, 38-41, 43-45, 47-52; Jo 1:1-2, 6-17, 19-26, 29-48, 50; Jo 2:1-4, 6-12, 14-16, 18-23, 25; Jo 3:1-4, 7-12, 14, 16-18, 20-22, 25-26, 28-36; Jo 4:2, 4-19, 21-30, 32-54; Jo 5:1-15, 17-29, 31-47; Jo 6:1, 3-15, 17-21, 23-24, 26-43, 45-46, 50-57, 59-64, 66-68, 70-71; Jo 7:1-7, 9-33, 35-42, 44-52; Jo 8:2-22, 24-31, 33-35, 37, 39-45, 47-50, 52-58; Jo 9:1, 3, 5-8, 11-13, 15-19, 21-34, 36-41; Jo 10:2-7, 10, 12-18, 20-25, 27-28, 31, 33-37, 39-41; Jo 11:2-9, 11-20, 23-34, 36-40, 42-49, 51-57; Jo 12:1-12, 14-38, 40-50; Jo 13:1-21, 23-34, 36-38; Jo 14:1-3, 5-11, 13, 16-18, 20-31; Jo 15:2-13, 15-17, 19-27; Jo 16:1-8, 12-15, 17-33; Jo 17:2-6, 8, 10, 13-15, 18-20, 22-26; Jo 18:1-29, 31-40; Jo 19:1-42; Jo 20:1-21, 23-28, 30-31; Jo 21:1-14, 18-24; 1Co 15:42, 50, 52-54

## Recomendação de edição (decisão do dono)

Números: exatos n4 303 de 3836, exatos tr 287 de 3836.
A n4 casa pelo menos tanto quanto a tr com o texto que o protótipo já usava, conversa com o grego crítico que o projeto pretende juntar depois e marca os trechos duvidosos com « ». Recomendação da pesquisa mantida: n4.
A tr não tem o texto de At 28:29 no arquivo-fonte (só uma nota); a n4 traz o versículo marcado com « ». A escolha é do dono; trocar depois é mudar um campo.

