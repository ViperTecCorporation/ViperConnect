# Histórico de mensagens

## Visão geral

A UnoAPI separa a **captura** do histórico no WhatsApp do **encaminhamento** para os webhooks:

- Baileys e Zapo capturam histórico durante a sincronização inicial ou sob demanda.
- A Zapo persiste conversas e mensagens no store da sessão. Quando `useRedis=true`, esse store fica no Redis; SQLite é usado apenas quando o store Zapo é configurado sem Redis.
- O histórico já persistido pode ser encaminhado novamente a qualquer momento. Não é necessário gerar ou ler outro QR Code.
- Mensagens mais antigas que ainda não estão no store precisam ser solicitadas ao WhatsApp por conversa.

## Configuração por sessão

| Campo | Tipo | Padrão | Comportamento |
|---|---:|---:|---|
| `ignoreHistoryMessages` | boolean | `true` | Quando `false`, encaminha ao webhook o histórico recebido em uma sincronização. |
| `historyMaxAgeDays` | number | `HISTORY_MAX_AGE_DAYS` ou `30` | Limita a idade das mensagens encaminhadas. Valores aceitos: 1 a 3650 dias. |

O valor da sessão prevalece sobre a variável de ambiente. Valores inválidos são normalizados para 30 dias. Alterar a janela não força uma nova captura do WhatsApp; ela define quais mensagens já persistidas podem ser encaminhadas.

No Manager, os campos ficam juntos em **Ignorar Histórico de Mensagens** e **Janela do histórico (dias)**.

## Encaminhamento automático na Zapo

Quando `ignoreHistoryMessages=false`, a UnoAPI aguarda o chunk final da sincronização Zapo (`progress=100`), consulta o store usando `historyMaxAgeDays`, ordena as mensagens da mais antiga para a mais nova e as envia pelo fluxo normal de webhook com o tipo interno `history`.

Chunks parciais não disparam replay. IDs recebidos como eventos ao vivo no processo atual também são excluídos do replay automático.

## Reprocessar o que já está persistido

Use a rota administrativa existente:

```http
POST /v19.0/{phone}/debug/history_on_demand
Authorization: {token-da-sessao-ou-global}
Content-Type: application/json

{
  "replay_stored": true,
  "days": 7
}
```

Resposta:

```json
{
  "success": true,
  "phone": "5566999999999",
  "forwarded": 42
}
```

Esse modo consulta somente o store existente e não solicita QR Code nem nova sincronização ao aparelho.

Por padrão, o worker não reenvia IDs já encaminhados por ele desde a última inicialização. Para um replay intencional completo dentro da janela:

```json
{
  "replay_stored": true,
  "force_replay": true,
  "days": 30
}
```

`force_replay=true` pode entregar novamente mensagens que a aplicação já recebeu. O consumidor deve manter idempotência pelo ID da mensagem. O controle de replay da UnoAPI é local ao processo e não substitui a deduplicação persistente da aplicação.

## Buscar mensagens mais antigas no WhatsApp

A Zapo oferece history sync sob demanda por conversa. Informe como cursor a mensagem mais antiga já conhecida:

```http
POST /v19.0/{phone}/debug/history_on_demand
Authorization: {token-da-sessao-ou-global}
Content-Type: application/json

{
  "chat_jid": "123456789@lid",
  "message_id": "ID_DA_MENSAGEM_MAIS_ANTIGA",
  "from_me": false,
  "timestamp": 1784688000000,
  "count": 100
}
```

A resposta confirma apenas que a solicitação foi enviada:

```json
{
  "success": true,
  "phone": "5566999999999",
  "request_id": "ID_DA_SOLICITACAO"
}
```

O lote chega depois pelo evento `history_sync_chunk`, é persistido no store e, se `ignoreHistoryMessages=false`, é encaminhado automaticamente respeitando `historyMaxAgeDays`. A sessão precisa estar conectada e o WhatsApp pode limitar o histórico disponibilizado.

## Leitura e presença relacionadas

- `readOnReceipt=true`: envia recibo oficial de leitura após processar uma mensagem recebida.
- `readOnReply=true`: após o envio, resolve PN e LID da conversa, localiza a última mensagem recebida e envia o recibo oficial de leitura. Falha no recibo não transforma um envio bem-sucedido em falha.
- `composingMessage=true`: a Zapo publica `composing` antes do envio e `paused` ao terminar. Mensagens de áudio usam o fluxo próprio de mídia/áudio.

Essas opções são independentes de histórico.

## Operação segura

1. Configure primeiro uma janela curta, como 3 ou 7 dias.
2. Garanta idempotência no destino pelo ID da mensagem.
3. Desative **Ignorar Histórico de Mensagens** apenas na sessão que será testada.
4. Use `replay_stored` sem `force_replay` no primeiro teste.
5. Use a busca no servidor por conversa somente quando o store não possuir o período necessário.
