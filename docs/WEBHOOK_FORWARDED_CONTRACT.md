# Contrato de mensagem encaminhada — ViperConnect → ViperChat

## Escopo

Campo aditivo no webhook existente. Não cria endpoint nem evento novo.
Implementado no código local; requer publicação e atualização do worker para
chegar à produção. Esta entrega não altera nem publica o receptor ViperChat.

## Payload

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "5511888888888",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "5511888888888",
          "phone_number_id": "5511888888888"
        },
        "contacts": [{"wa_id":"5511999999999","user_id":"123@lid","profile":{"name":"Contato exemplo"}}],
        "messages": [{
          "id": "00000000-0000-4000-8000-000000000001",
          "from": "5511999999999",
          "timestamp": "1790000000",
          "type": "text",
          "text": {"body":"Mensagem recebida"},
          "context": {"forwarded":true}
        }]
      }
    }]
  }]
}
```

Quando houver resposta citada, o mesmo contexto pode ser:

```json
{
  "id": "UUID_UNOAPI_DA_MENSAGEM_CITADA",
  "message_id": "UUID_UNOAPI_DA_MENSAGEM_CITADA",
  "forwarded": true
}
```

`provider_message_id` continua opcional nas referências conforme o contrato
existente. Não substitua os IDs operacionais por ele.

## Semântica fechada nesta etapa

- Origem: `contextInfo.isForwarded === true` **da mensagem atual**, após
  normalização do wrapper. Marca de conteúdo citado não é herdada.
- Destino: `entry[].changes[].value.messages[].context.forwarded`, booleano
  opcional. Emitido somente como `true`. Pode existir sem qualquer referência
  de resposta. Não exigir `context.id` para aceitar o contexto.
- Sem marca: omitir `forwarded`; não afirmar que a mensagem é original.
- Preservar corpo, mídia, IDs, grupo, resposta citada e regras de entrega/filtro.
  Não publicar um segundo evento apenas para anunciar encaminhamento.
- Mesma regra no conversor de texto/mídia/grupos e em histórico/replay quando o
  conteúdo armazenado contiver a marca. Sem backfill de mensagens já entregues.
- Não acrescentar contexto a recibos/status. Receber a marca não solicita
  automaticamente ao WhatsApp marcar novos envios como encaminhados;
  o fluxo inverso abaixo exige intenção explícita no envio.
- `forwardingScore` e `frequently_forwarded` ficam **fora desta etapa**. Não
  inferir “encaminhada muitas vezes”, número de repasses, autor original ou rota.
- Autenticação, destino e configuração de webhook permanecem os existentes.

## Fluxo inverso: envio pelo ViperChat

O endpoint `POST /v15.0/{phone}/messages` agora aceita
`context: { "forwarded": true }` junto ao conteúdo completo de texto/mídia.
Não é necessário ID da mensagem original: a Zapo usa `options.forward=true`.
Isso **não busca/copia mensagem por ID**; o ViperChat já seleciona a mensagem
e prepara conteúdo/anexos em `Messages::ForwardService`.

Para integrar no receptor/emissor ViperChat, mapear a intenção explícita de
encaminhar (os atributos internos `forwarded_from_conversation_id` e
`forwarded_from_message_id`) para o booleano público, sem enviar esses IDs
como `context.id`/`message_id`: eles são referências de resposta citada.
Não marcar envios comuns apenas porque o conteúdo recebido tinha o selo.

Tipos suportados: text, image, video, audio, document, sticker, contacts e
location. A flag deve ser booleana; false/ausente preservam o envio normal.
Tipos não suportados retornam 400. Encaminhamento com referência citada explícita
mantém o fluxo de resposta existente. Não há campo público de score.
Ecos de saída habilitados preservam a marca em messages/message_echoes.
Isso não altera a integração Meta Cloud direta nem comprova entrega.

Implementação do envio: `src/services/messages/outgoing_forwarded.ts`,
`src/controllers/messages_controller.ts`, `src/services/zapo/zapo_messages.ts`
e `src/jobs/incoming.ts`. Contrato detalhado PT/EN nos guias de mensagens.

## Caminhos de recepção no ViperConnect

- `src/services/zapo/zapo_events.ts`: `toUnoMessageEvent` preserva o proto recebido.
- `src/services/transformer/forwarded_context.ts`: helper puro que acrescenta a marca.
- `src/services/transformer.ts`: aplica o helper após referências de resposta/edição.
- `src/services/listener_zapo.ts`: normalização, IDs UnoAPI, filtros e entrega existente.
- `__tests__/services/forwarded_context.ts`: contrato e casos negativos.
- `__tests__/services/listener_zapo.ts`: entrega e preservação da referência citada.
- `docs/openapi.yaml`: `WebhookMessageIdentity.properties.context.properties.forwarded`.
- `docs-site/guide/webhooks.md` e `docs-site/en/guide/webhooks.md`: guia integrado PT/EN.

## Instruções para o agente do ViperChat

Referência inspecionada: branch `feat/agent-voip-webphone`, commit `c283c7e88`.
Revalidar o checkout e as alterações pendentes antes de implementar. Não alterar
o fluxo VoIP nem descartar alterações de outros trabalhos.

1. Na ingestão compartilhada, ler o contexto da mensagem atual e persistir
   `content_attributes['forwarded'] = true` somente para booleano `true`.
   Não persistir o payload inteiro nem depender de `context.id`.
2. Ponto principal: `app/services/whatsapp/incoming_message_base_service.rb`,
   método `message_content_attributes`. Meta Cloud e UnoAPI compartilham essa
   base através de `incoming_message_whatsapp_cloud_service.rb` e
   `incoming_message_unoapi_service.rb`. Preservar os merges dos overrides,
   referência citada, catálogo, interativos, `view_once` e ingestão unificada.
3. `app/services/whatsapp/incoming_message_service_helpers.rb`, método
   `process_in_reply_to`, trata os IDs citados. Não interpretar um contexto só
   com `forwarded` como resposta, nem criar associação a mensagem inexistente.
4. Na bolha atual, `app/javascript/dashboard/components-next/message/Message.vue`,
   renderizar um rótulo discreto “Encaminhada” acima do conteúdo para a mensagem
   marcada. Conferir a normalização snake_case/camelCase dos atributos; esse
   nome não muda (`forwarded`). Criar tradução PT/EN e teste do componente.
   Não concatenar o rótulo ao corpo salvo, nem alterar prévia, mídia ou IDs.
5. O caminho da lista usa `components/widgets/conversation/MessagesView.vue`
   e `components-next/message/MessageList.vue`. Se houver visualização legada
   em uso, avaliar também `components/widgets/conversation/Message.vue`.
6. Testar Meta Cloud e UnoAPI: contexto só com marca; marca + resposta citada;
   contexto ausente; `forwarded=false`; string `"true"` (não aceitar como marca);
   texto e mídia; grupo; reentrega/deduplicação e ingestão unificada. A bolha
   deve aparecer uma só vez e manter referência e conteúdo intactos.
7. Não exibir “Encaminhada muitas vezes” nesta etapa: o ViperConnect ainda não
   emite `frequently_forwarded`. Se suportar esse campo da Meta separadamente,
   documentar e testar como outro caso, sem inferir a partir de `forwarded`.

Validação real ponta a ponta depende da publicação dos dois lados e de uma
mensagem encaminhada em teste controlado. Testes locais não comprovam deploy.
