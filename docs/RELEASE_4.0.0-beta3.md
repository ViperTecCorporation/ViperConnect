# UnoAPI 4.0.0-beta3

## Correções

- torna determinístico o processamento assíncrono da rejeição de chamadas Zapo;
- isola os módulos nativos do VoIP nos testes unitários do cliente Zapo;
- adiciona `GET /{phone}/contacts` para listar, com paginação, os contatos sincronizados no Redis pela Zapo;
- retorna LID como `user_id` e telefone sem sufixo, acrescentando o nono dígito somente em celulares brasileiros.

Esta versão inclui integralmente as alterações da `v4.0.0-beta2`.
