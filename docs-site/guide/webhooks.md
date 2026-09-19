# Webhooks

O ViperConnect envia payloads no formato `object → entry → changes → value`.
Responda HTTP `2xx` rapidamente e processe o evento de forma idempotente.

Eventos de conexão usam um contrato separado: [Webhooks de sessões](./session-webhooks).

## Blacklist e isolamento de histórico

`POST /{phone}/blacklist/{webhook_id}` aceita telefone, `@s.whatsapp.net`, `@lid`
e grupo `@g.us`. `ttl` é em **segundos**: positivo expira, negativo persiste,
zero ou omitido remove. Telefone e LID equivalem quando vinculados no store da
mesma sessão; grupos não se confundem com seus participantes. Sem vínculo conhecido,
só a identidade informada pode ser tratada. Chaves antigas continuam válidas,
consultadas nos eventos novos, sem recadastro. A resposta confirma enfileiramento
em instalações AMQP; mensagens já entregues não podem ser desfeitas.

Histórico usa filas próprias de processamento, webhook e transcrição, com dois
consumidores por processo/etapa. Filtros e payloads não mudam; mensagens novas
podem ultrapassar histórico. Recursos como CPU, rede e Redis continuam compartilhados.
Publicações AMQP aguardam confirmação antes do ACK de consumo; isso não significa
entrega exatamente uma vez, nem confirmação do destinatário WhatsApp. Uma confirmação
perdida pode causar repetição. Áudio e comandos VoIP não usam esse caminho de publicação.

## Mensagem de texto recebida

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "5511999999999",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "5511999999999",
          "phone_number_id": "5511999999999"
        },
        "contacts": [{
          "profile": {"name": "Maria"},
          "wa_id": "5511912008012",
          "user_id": "273877414502425@lid"
        }],
        "messages": [{
          "from": "5511912008012",
          "from_user_id": "273877414502425@lid",
          "id": "wamid.HBgMNTUxMTkxMjAwODAxMhUCABIY...",
          "timestamp": "1785100000",
          "type": "text",
          "text": {"body": "Olá"}
        }],
        "statuses": []
      }
    }]
  }]
}
```

`user_id` é a identidade estável quando presente. Telefone e nome são
metadados complementares.

## Resposta de botão

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {"id": "continuar", "title": "Continuar"}
  },
  "context": {"id": "ID_DA_MENSAGEM_INTERATIVA"}
}
```

## Resposta de lista

```json
{
  "type": "interactive",
  "interactive": {
    "type": "list_reply",
    "list_reply": {"id": "pro", "title": "Profissional", "description": "Plano completo"}
  }
}
```

## Status de entrega

```json
{
  "statuses": [{
    "id": "wamid.HBgMNTUxMTkxMjAwODAxMhUCABIY...",
    "status": "delivered",
    "timestamp": "1785100004",
    "recipient_id": "5511912008012"
  }],
  "messages": []
}
```

Estados usuais: `sent`, `delivered`, `read`, `played` e `failed`.

## Falha

```json
{
  "statuses": [{
    "id": "ID_DA_MENSAGEM",
    "status": "failed",
    "recipient_id": "5511912008012",
    "errors": [{
      "code": 131000,
      "title": "Falha ao enviar",
      "message": "Descrição normalizada do erro"
    }]
  }]
}
```

## Mensagem indisponível

Quando o conteúdo original não pode ser recuperado, o webhook entrega uma
mensagem de texto explícita:

```json
{"type":"text","text":{"body":"Mensagem indisponível nesta integração. Confira o aparelho."}}
```

## Segurança e entrega

- Use HTTPS e valide o token no cabeçalho configurado.
- Retorne `2xx` antes de executar tarefas demoradas.
- Deduplicate por `messages[].id` ou `statuses[].id`.
- Com `WEBHOOK_ASYNC_MODE=amqp`, falhas transitórias permanecem na fila.
- Configure circuit breaker e timeout abaixo do timeout global do consumidor.
