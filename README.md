# Jesus nas Fontes

Aplicação web para estudar a pessoa de Jesus nas fontes: três Trilhas de estudo, com o texto
bíblico, Sessões, Anotações privadas e áudio. O acesso é por convite.

## Como rodar

Requisitos: Node.js 24 ou superior, pnpm e Docker (os testes de integração e de ponta a ponta
usam um Postgres 17 local e descartável).

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm dev
```

A aplicação abre em `http://localhost:3000`. Variáveis de ambiente são lidas pelos módulos de
`src/lib/env.ts`, que lista só os nomes quando algo falta.

Scripts principais:

| Script | O que faz |
|--------|-----------|
| `pnpm typecheck` | verificação de tipos |
| `pnpm lint` | Biome |
| `pnpm test` | testes de unidade |
| `pnpm test:integration` | testes de integração em um banco local por execução |
| `pnpm test:e2e` | testes de ponta a ponta com banco, porta e build próprios |
| `pnpm gate:publico` | verificação de publicação (abaixo) |
| `pnpm verify` | todos os anteriores, em sequência |

## Verificação de publicação

Antes de qualquer publicação do repositório, rode:

```bash
bash scripts/gate/selftest.sh
bash scripts/gate/check-public-ready.sh .
```

O primeiro prova que a verificação reprova cada classe de vazamento; o segundo varre o histórico
inteiro deste repositório. Sai com 0 só quando tudo está limpo.

## Licenças

- Código: MIT (`LICENSE`).
- Conteúdo em `content/`: CC BY-SA 4.0 (`content/LICENSE`).
- Texto bíblico e atribuições: ver `NOTICE.md`.
