# Webhooks

Para recuperar configurações anteriores após recriar uma sessão, consulte
[Histórico e restauração de webhooks](/guide/webhook-history). A restauração é manual
e não interfere na conexão ou reconexão.

O ViperConnect envia payloads no formato `object → entry → changes → value`.
Responda HTTP `2xx` rapidamente e processe o evento de forma idempotente.

Eventos de conexão usam um contrato separado: [Webhooks de sessões](./session-webhooks).

## Mensagem encaminhada

Quando a mensagem atual recebida pela Zapo traz `contextInfo.isForwarded=true`,
o ViperConnect entrega `context.forwarded=true` em
`entry[].changes[].value.messages[]`. Exemplo parcial da mensagem:

```json
{
  "type": "text",
  "text": { "body": "Mensagem recebida" },
  "context": { "forwarded": true }
}
```

A alteração é aditiva e automática, sem configuração ou permissão adicional às
do webhook existente. Texto, mídia, grupos e wrappers normalizados usam a mesma
regra. Mensagens de histórico/replay que passem pelo conversor preservam a marca
quando ela estiver disponível no conteúdo armazenado. Não é feita consulta ao
WhatsApp para preencher metadados ausentes nem correção retroativa de webhooks.

- O campo só é emitido como booleano `true`; não envie `false` por ausência de
  metadados. Ausência significa **sem marca disponível**, não prova de autoria.
- `context` pode conter apenas `forwarded`, sem `id` ou `message_id`.
- Uma resposta citada mantém `context.id`, `message_id` e, quando aplicável,
  `provider_message_id`. A marca da mensagem citada não passa para a resposta.
- Status de entrega não recebem esse contexto. A mudança não transforma um
  envio comum em encaminhamento nem adiciona prefixo ao texto.
- `forwardingScore` e `frequently_forwarded` **não são emitidos neste contrato**.
  Não inferir contagem, autor original, cadeia de conversas ou o selo de
  “encaminhada muitas vezes”.

Contrato e caminhos para o receptor ViperChat no repositório:
`docs/WEBHOOK_FORWARDED_CONTRACT.md`.

## ID original do transporte

No runtime Zapo, `provider_message_id` é um campo **opcional e aditivo** para
correlação. `messages[].id`, `message_echoes[].id`, `statuses[].id`, os IDs de
referência, os IDs de mídia e as respostas da API continuam iguais. Não use esse
campo no lugar do ID UnoAPI para enviar, citar, editar ou excluir mensagens.

**Typebot:** quando o webhook estiver marcado como Typebot, esse campo não é
entregue, inclusive em contexto, reação e status. A remoção é feita somente na
cópia daquele destinatário; ViperChat e outros webhooks preservam os metadados.
Os filtros atuais de eventos para Typebot continuam iguais.

| Objeto | Significado de `provider_message_id` |
| --- | --- |
| `value.messages[]` / `value.message_echoes[]` | ID original da mensagem/evento |
| `value.statuses[]` | ID original da mensagem cujo status mudou |
| `message.context` | ID original da mensagem citada ou editada |
| `message.reaction` | ID original da mensagem que recebeu a reação |

Na exclusão, o contrato atual é `statuses[].status: "deleted"`: tanto `id`
quanto o novo campo identificam a **mensagem excluída**, não o evento de exclusão.
Na edição, `messages[].id` identifica o evento e `context` identifica o alvo.

```json
{
  "id": "UUID_UNOAPI_DO_EVENTO",
  "provider_message_id": "ID_PROTOCOLO_DO_EVENTO",
  "type": "text",
  "message_type": "message_edit",
  "text": { "body": "Texto corrigido" },
  "context": {
    "id": "UUID_UNOAPI_ORIGINAL",
    "message_id": "UUID_UNOAPI_ORIGINAL",
    "provider_message_id": "ID_PROTOCOLO_ORIGINAL"
  }
}
```

Trate o valor como string opaca, sem truncar, converter caixa ou adicionar prefixos
como `wamid`. A correlação entre transportes ainda precisa de validação em produção.
O campo é capturado antes da conversão para UUID, acompanha a publicação normal
do webhook e seus retries, sem mudar filas, filtros ou regras de envio.
É omitido quando não há ID original comprovado (inclusive avisos sintéticos de
chamada, falhas antes da confirmação e eventos antigos). Eventos já entregues não
são reenviados; consumidores devem aceitar payloads sem esse campo.
No envio por API, a confirmação do provider ocorre no worker: o ID adicional chega
pelo echo/status correspondente, não pela resposta de enfileiramento da API.

## Mídia de visualização única

O recebimento de imagem, vídeo ou áudio de visualização única inclui
`message_type: "view_once"` no próprio objeto de `value.messages[]`.
`type` continua `image`, `video` ou `audio`; o ID UnoAPI e o objeto da mídia
permanecem iguais. É uma extensão ViperConnect, não um evento de edição nem
um novo evento posterior. Não adiciona `context` ou `edit_timestamp`; contexto
de resposta já existente é preservado.

O marcador vem do payload original (`imageMessage.viewOnce`, equivalentes de
vídeo/áudio, ou wrappers `viewOnceMessage`, `viewOnceMessageV2` e
`viewOnceMessageV2Extension`) e é preservado ao desembrulhar. Não há consulta
adicional ao Redis, download extra ou reenvio. Mensagens comuns, citações de
visualização única e mensagens apenas temporárias não recebem esse marcador.
Mídia indisponível mantém o fallback existente; este campo não recupera conteúdo.

```json
{
  "id": "ID_UNOAPI_DA_MENSAGEM",
  "from": "5566996269251",
  "timestamp": "1790672409",
  "type": "image",
  "message_type": "view_once",
  "image": {
    "id": "5566936183915/ID_UNOAPI_DA_MENSAGEM",
    "mime_type": "image/jpeg",
    "url": "https://example.test/media.jpg"
  }
}
```

No ViperChat, persistir o marcador junto à mensagem/anexo e informar
“Você recebeu uma mensagem de visualização única”. Deduplicar pelo ID normal;
não tratar como edição ou aguardar atualização posterior. O marcador não
impõe acesso único: a política atual de armazenamento e URLs não é alterada.
Evitar prévia automática até a aplicação definir sua política de visualização.
Webhooks antigos já entregues não são reenviados automaticamente.

## Eco de edição enviada

Ao editar pela API (`type: "message_edit"`), o eco enviado após sucesso usa
`type: "text"`, `text.body` com o texto corrigido e
`message_type: "message_edit"`. `context.message_id` e `context.id` apontam
para o ID UnoAPI original; `id` continua sendo o ID do evento de edição.
`edit_timestamp` informa o horário de processamento em milissegundos.

O ViperChat recebe esse objeto em `value.message_echoes`, no campo
`smb_message_echoes`; destinos comuns o recebem em `value.messages`.
Isso permite atualizar e marcar o original como editado, sem criar outra
mensagem. A configuração `sendNewMessages` continua controlando esses ecos.
Eventos antigos já enfileirados no consumidor não são reparados automaticamente.

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

<!--@include: ../../docs/AUDIO_TRANSCRIPTION.md-->

<!--@include: ../../docs/REPLY_WARNINGS.md-->
