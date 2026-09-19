# Eco de edição de mensagem

A requisição de edição continua usando `type: "message_edit"`, o texto em
`text.body` e a referência à mensagem original em `context.message_id`.
O envio à Zapo e a resposta HTTP não foram alterados.

Depois de um envio bem-sucedido, destinos com `sendNewMessages` habilitado recebem
a edição no contrato já usado pelas edições recebidas:

```json
{
  "id": "ID_DO_EVENTO_DE_EDICAO",
  "timestamp": "1789859012",
  "type": "text",
  "text": { "body": "Texto corrigido" },
  "message_type": "message_edit",
  "context": {
    "id": "ID_UNO_DA_MENSAGEM_ORIGINAL",
    "message_id": "ID_UNO_DA_MENSAGEM_ORIGINAL"
  },
  "edit_timestamp": 1789859012000
}
```

O envelope permanece `value.message_echoes`/`smb_message_echoes` para ViperChat
e `value.messages`/`messages` nos destinos comuns. Campos de remetente,
destinatário e grupo continuam seguindo o envelope existente.

`id` identifica o evento; `context` identifica o original. O consumidor deve
atualizar o original, não criar outra mensagem. `edit_timestamp` está em
milissegundos e deriva do horário de processamento do envio pela Uno; não é
uma confirmação de horário do aparelho.

O defeito anterior usava `type: "message_edit"` e tentava ler
`payload.message_edit`, que não existe no pedido normal. Por isso, o eco perdia
texto e referência e não acionava o tratamento de edição do ViperChat.
O backend do ViperChat pode já ter marcado a edição pela própria ação HTTP;
o eco completo mantém a atualização posterior no contrato correto.

## Validação e limites

- Testes do worker verificam os dois envelopes, conversa individual e grupo,
  ID do evento distinto do original e ausência de mutação do pedido.
- Testes do mapeador cobrem os aliases de referência aceitos pelo adapter Zapo
  e preservação dos demais tipos de mensagem.
- Não modifica deduplicação, retries, status, conexão ou normalização PN/LID.
- Há uma limitação preexistente no eco com `to` exclusivamente LID: a
  normalização atual pode produzir destinatário vazio. Não foi ampliado o
  escopo desta correção para alterar endereçamento.
- Não repara ecos antigos já persistidos no Sidekiq. Não reprocessar esses
  eventos presumindo que a atualização da Uno modifica seus payloads.
- A permanência do indicador visual requer validação após publicação. Não há
  comprovação de que o eco antigo tenha apagado `edited: true` no frontend.
