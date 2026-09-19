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

Chunks parciais não disparam replay. IDs recentes recebidos como eventos ao vivo
no processo atual também são excluídos do replay automático. Esse índice em
memória mantém no máximo 100.000 IDs por sessão durante até 30 dias; a aplicação
destinatária continua responsável pela idempotência persistente.

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

Por padrão, o worker não reenvia os até 100.000 IDs mais recentes encaminhados
nos últimos 30 dias desde a inicialização atual. Para um replay intencional
completo dentro da janela:

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

### Filas separadas

Eventos `history` usam `unoapi.history.<server>.<engine>` no exchange topic
`unoapi.broker`. O worker inicia dois consumidores fixos dessa fila, cada um
com canal próprio e `prefetch=1`, independentemente do número de sessões.
São consumidores no processo existente, não dois novos containers.

As demais mensagens continuam na fila listener existente. Os mesmos handlers,
filtros, janela de dias, deduplicação, IDs, payloads, prioridades e delays são
reutilizados; os gatilhos de sincronização não mudam.

Webhooks de histórico usam `unoapi.outgoing.history`; a transcrição opcional usa
`unoapi.transcribe.history` e retorna à saída de histórico. O broker inicia dois
consumidores por etapa, sem ocupar os consumidores das filas normais. Não há
novas ENVs. Prefixos seguem `UNOAPI_QUEUE_NAME`. Cada réplica acrescenta seus
próprios dois consumidores; não é um limite global entre réplicas.

Envelopes `history` pendentes na listener antiga são encaminhados à nova fila
quando consumidos, sem desempacotar nem processar e preservando o orçamento de
retries. Isso também vale quando um retry antigo retorna do delay. Não se apaga
ou purga a fila antiga. Webhooks já transformados na saída antiga permanecem
nela: não possuem marcador confiável para reconhecer histórico retroativamente.

Retries e mensagens mortas ficam nas filas `.delayed` e `.dead` da respectiva
etapa, com a política de tentativas existente. Publicações por `amqpPublish`
aguardam a confirmação individual do RabbitMQ e rejeitam mensagens retornadas
sem rota (`mandatory`). O consumidor somente confirma o original depois da
publicação confirmada. Se nem o retry/dead-letter puder ser publicado, fecha o
canal consumidor, preservando as mensagens sem ACK para reentrega.

A espera de confirmação tem limite de 30 segundos e descarta o canal incerto.
Isso não garante entrega exatamente uma vez: uma queda após o broker aceitar
a publicação, mas antes da confirmação chegar ao cliente, pode gerar duplicata.
O destino deve continuar idempotente pelo ID. RPC mantém seu fluxo próprio de
resposta/correlationId. A validação estrita aceita `*` como binding de consumidor,
mas continua rejeitando esse curinga como destinatário de publicação.
Mensagens novas podem ultrapassar histórico; não há ordenação global entre filas.
CPU, Redis, rede e destino dos webhooks continuam compartilhados.

Na publicação, atualizar os processos worker **e** broker em todas as réplicas.
Réplicas antigas ainda podem consumir histórico pela listener compartilhada.
No rollback, as novas filas devem ser drenadas com consumidores compatíveis:
uma versão antiga não consome essas filas. Não purgar mensagens pendentes.

### Validação operacional

Após publicar, reconectar uma sessão com histórico habilitado e enviar uma
mensagem nova durante a sincronização. Conferir os consumidores das três filas,
o recebimento do webhook novo antes de drenar o histórico, o atraso de entrega
e as contagens ready/unacked/dead. Repetir com webhook lento e áudio quando a
transcrição estiver habilitada. A validação automatizada simula o transporte
AMQP; não substitui esta conferência com RabbitMQ real.

1. Configure primeiro uma janela curta, como 3 ou 7 dias.
2. Garanta idempotência no destino pelo ID da mensagem.
3. Desative **Ignorar Histórico de Mensagens** apenas na sessão que será testada.
4. Use `replay_stored` sem `force_replay` no primeiro teste.
5. Use a busca no servidor por conversa somente quando o store não possuir o período necessário.
