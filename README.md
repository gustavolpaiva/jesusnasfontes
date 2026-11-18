# Jesus nas Fontes

Aplicação web para estudar a pessoa de Jesus nas fontes: três Trilhas de estudo, com o texto
bíblico, Sessões, Anotações privadas e áudio. O acesso é por convite.

## Como rodar

A aplicação ainda não foi iniciada neste repositório: por enquanto ele traz as licenças, a lista
de pacotes e a verificação de publicação abaixo. As instruções de execução entram junto com o
código da aplicação.

Requisitos previstos: Node.js 24 ou superior e pnpm.

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
