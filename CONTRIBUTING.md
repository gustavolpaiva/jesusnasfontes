# Como contribuir

## Licença das contribuições

- Código: ao contribuir, você o oferece sob a licença MIT (`LICENSE`).
- Conteúdo em `content/`: ao contribuir, você o oferece sob a CC BY-SA 4.0 (`content/LICENSE`).
- O texto bíblico segue a licença própria descrita em `NOTICE.md`; não o altere.

## Antes de publicar qualquer coisa

Rode a verificação de publicação:

```bash
bash scripts/gate/selftest.sh
bash scripts/gate/check-public-ready.sh .
```

Ela varre todos os commits, mensagens, autores e nomes de branch. Só publique com saída 0.

Os commits usam o endereço "noreply" do GitHub de quem contribui; nenhum endereço de e-mail
pessoal ou de empresa pode aparecer no histórico.
