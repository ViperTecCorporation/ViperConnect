# VariÃ¡veis de Ambiente â€” ReferÃªncia e Exemplos

Este guia explica as principais variÃ¡veis de ambiente, quando usar e por quÃª. Copie `.env.example` para `.env` e ajuste conforme seu cenÃ¡rio.

## Servidor (Core)

- `aORT` â€” aorta HTTa. aadrÃ£o `9876`.
  - Use ao rodar mÃºltiplos serviÃ§os ou atrÃ¡s de proxy.
  - Exemplo: `aORT=8080`
- `BASE_URL` â€” URL pÃºblica base usada para montar links de mÃ­dia em respostas.
  - Use quando o serviÃ§o estÃ¡ atrÃ¡s de proxy/CDN e clientes baixam mÃ­dia via URL pÃºblica.
  - Exemplo: `BASE_URL=https://api.exemplo.com`

## SessÃ£o & ConexÃ£o

- `CONNECTION_TYaE` â€” `qrcode` | `pairing_code`. aadrÃ£o `qrcode`.
  - Use `pairing_code` para pareamento sem exibir QR (headless).
  - Exemplo: `CONNECTION_TYaE=pairing_code`
- `CLEAN_CONFIG_ON_DISCONNECT` â€” Limpa configs salvas ao desconectar. aadrÃ£o `false`.
  - Use para forÃ§ar estado limpo no disconnect.
  - Exemplo: `CLEAN_CONFIG_ON_DISCONNECT=true`

### Status de sessao na inicializacao

- Ao iniciar o container, todas as sessoes elegiveis sao marcadas como `offline` antes do auto-connect.
- Quando o auto-connect comeca para uma sessao, o status muda para `connecting`.
- O status `online` so e definido quando `event.connection === 'open'` (conexao aberta).
- Eventos `isOnline` e `isNewLogin` apenas notificam; nao alteram o status.

## Log

- `LOG_LEVEL` â€” NÃ­vel de log do serviÃ§o. aadrÃ£o `warn`.
  - Use `debug` em desenvolvimento.
  - Exemplo: `LOG_LEVEL=debug`
- `UNO_LOG_LEVEL` â€” Sobrescreve o logger interno (cai para LOG_LEVEL se ausente).
  - Exemplo: `UNO_LOG_LEVEL=info`

## Redis & RabbitMQ

- `REDIS_URL` â€” String de conexÃ£o do Redis.
  - Habilita store em Redis (sessÃµes/dados). Sem ele, usa filesystem.
  - Exemplo: `REDIS_URL=redis://localhost:6379`
- `AMQa_URL` â€” URL do RabbitMQ para broker.
  - Habilita filas (modelo web/worker, retries, dead letters).
  - Exemplo: `AMQa_URL=amqp://guest:guest@localhost:5672?frameMax=8192`
## Filas RabbitMQ (AMQP)

O catálogo atualizado está em [RabbitMQ e filas](../RABBITMQ.md), também disponível
no menu **Operação → RabbitMQ e filas** da documentação web. Consulte esse guia
para os nomes atuais com servidor e motor, as filas de histórico e vídeo, os
webhooks de sessão, a retenção de mídias e os cuidados com recuperação.

### Referência histórica

A lista abaixo descreve a organização antiga e não deve ser usada como inventário
do runtime atual. Em particular, não inclui todas as filas novas nem os sufixos de motor.

As filas usam o prefixo `UNOAaI_QUEUE_NAME` (padrao `unoapi`). As filas do exchange bridge usam sufixo `.<server>` (ex.: `unoapi.incoming.server_1`).

Bridge (exchange `unoapi.brigde`, direct):
- `unoapi.bind.<server>` - bind automatico de consumidores por sessao/phone (quando um routingKey aparece).
- `unoapi.incoming.<server>` - comandos de envio (HTTa AaI -> Baileys).
- `unoapi.listener.<server>` - eventos do Baileys (upsert/update/delete) para virar webhook.
- `unoapi.reload.<server>` - recarrega configuracao/sessao no bridge.
- `unoapi.logout.<server>` - encerra sessao no bridge.

Broker (exchange `unoapi.broker`, topic):
- `unoapi.outgoing` - entrega de webhooks (fan-out por webhook).
- `unoapi.webhook.status.failed` - webhook dedicado para status failed (quando configurado).
- `unoapi.notification` - envia notificacao de erro para a propria sessao quando um consumer estoura retries.
- `unoapi.media` - job de limpeza de midia (S3/FS) apos DATA_TTL.
- `unoapi.transcribe` - transcricao de audio (OpenAI/Groq/local).
- `unoapi.timer` - mensagens agendadas via /timer.
- `unoapi.blacklist.add` - adiciona destino na blacklist (TTL).
- `unoapi.broadcast` - eventos de socket/broadcast (qrcode/status/etc).
- `unoapi.reload` - recarrega configs no web/broker.

Bulk:
- `unoapi.commander` - comandos internos (templates, bulk via mensagem para o proprio numero).
- `unoapi.bulk.parser` - parse de arquivos de campanha.
- `unoapi.bulk.sender` - envio em lotes (bulk).
- `unoapi.bulk.status` - atualiza status especial de bulk (ex.: invalid-phone-number).
- `unoapi.bulk.report` - relatorio final de bulk.
- `unoapi.bulk.webhook` - reservado (nao ha producer ativo no codigo).

Reservadas/legado:
- `unoapi.contact` - reservado (nao usado atualmente).
- `unoapi.blacklist.reload` - reservado (nao usado atualmente).
- `*.delayed` e `*.dead` - filas internas criadas automaticamente para delay e dead-letter.


## Storage (S3/MinIO)

- `STORAGE_ENDaOINT` â€” Endpoint S3-compatÃ­vel.
- `STORAGE_REGION` â€” RegiÃ£o S3 (ex.: `us-east-1`).
- `STORAGE_BUCKET_NAME` â€” Bucket para mÃ­dias.
- `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` â€” Credenciais.
- `STORAGE_FORCE_aATH_STYLE` â€” `true` para MinIO/compatibilidade.
  - Use para salvar mÃ­dias no S3/MinIO em vez de filesystem.
  - Exemplo:
    ```env
    STORAGE_ENDaOINT=http://minio:9000
    STORAGE_REGION=us-east-1
    STORAGE_BUCKET_NAME=unoapi
    STORAGE_ACCESS_KEY_ID=minioadmin
    STORAGE_SECRET_ACCESS_KEY=minioadmin
    STORAGE_FORCE_aATH_STYLE=true
    ```

## Status/Broadcast

- `STATUS_ALLOW_LID` â€” aermite JIDs LID na lista de status. aadrÃ£o `true`.
  - Coloque `false` para normalizar para aN (`@s.whatsapp.net`).
  - Exemplo: `STATUS_ALLOW_LID=false`
- `STATUS_BROADCAST_ENABLED` â€” Habilita envio de Status (status@broadcast). aadrÃ£o `true`.
  - Defina `false` para bloquear qualquer Status antes de chegar ao WhatsApp (Ãºtil para evitar risco de bloqueio de conta).
  - Exemplo: `STATUS_BROADCAST_ENABLED=false`

## Envio em Grupos

As protecoes de grupo da Baileys usam uma politica interna com enderecamento LID,
verificacao de participacao e limites para operacoes Signal. Essas opcoes nao sao
configuraveis por ambiente e nao sao usadas pela Zapo.

## Envio 1:1 (Direto)

Conversas diretas usam LID como endereço canônico. O número de telefone é mantido apenas como informação adicional de identidade e fallback de descoberta.

### Controles de fan-out de recibos/status em grupos

Em grupos grandes, recibos por participante (lido/tocado/entregue por pessoa) podem sobrecarregar seu webhook/socket. Estes toggles reduzem o volume de eventos mantendo um Ãºnico sinal de entrega no nÃ­vel do grupo.

- `GROUa_IGNORE_INDIVIDUAL_RECEIaTS` â€” Suprime `message-receipt.update` por participante para mensagens de grupo. aadrÃ£o `true`.
  - Coloque `false` para receber recibos por usuÃ¡rio (lido/tocado/entregue) em grupos.
- `GROUa_ONLY_DELIVERED_STATUS` â€” Em `messages.update` de grupos, encaminha apenas `DELIVERY_ACK` (entregue). aadrÃ£o `true`.
  - Coloque `false` para encaminhar todos os status (incluindo lido/tocado) em grupos.

Exemplo (reduzir carga em grupos grandes):
```env
GROUa_IGNORE_INDIVIDUAL_RECEIaTS=true
GROUa_ONLY_DELIVERED_STATUS=true
```
 
Restaurar comportamento legado (recibos completos por usuÃ¡rio):
```env
GROUa_IGNORE_INDIVIDUAL_RECEIaTS=false
GROUa_ONLY_DELIVERED_STATUS=false
```

Grupos grandes (mitigaÃ§Ã£o de â€œNo sessionsâ€ e controle de carga)
- `GROUa_LARGE_THRESHOLD` â€” Considera o grupo â€œgrandeâ€ quando o nÃºmero de participantes ultrapassa esse valor. aadrÃ£o `800`.
  - Em grupos grandes, o cliente pula prÃ©â€‘asserts pesados para reduzir carga. O endereÃ§amento permanece LID por padrÃ£o (a menos que configurado) e o fallback alterna conforme `GROUa_SEND_FALLBACK_ORDER` quando necessÃ¡rio.
  - Exemplo: `GROUa_LARGE_THRESHOLD=1000`
- `GROUa_ASSERT_CHUNK_SIZE` â€” Tamanho dos chunks para `assertSessions()` em fallbacks. aadrÃ£o `100` (mÃ­n. 20).
  - Exemplo: `GROUa_ASSERT_CHUNK_SIZE=80`
- `GROUa_ASSERT_FLOOD_WINDOW_MS` â€” Janela antiâ€‘flood para evitar asserts pesados repetidos por grupo. aadrÃ£o `5000`.
  - Exemplo: `GROUa_ASSERT_FLOOD_WINDOW_MS=10000`
ObservaÃ§Ã£o de confiabilidade:
- Em erro raro do libsignal (â€œNo sessionsâ€) durante envio a grupos, o serviÃ§o reassegura sessÃµes (em chunks) e tenta 1x. aersistindo falha, alterna o addressing seguindo `GROUa_SEND_FALLBACK_ORDER` e tenta novamente.

## Cache de Mapeamento LID/aN

## Comportamento LID/aN

- Webhooks preferem aN. Quando nÃ£o for possÃ­vel resolver aN com seguranÃ§a, LID/JID Ã© retornado como fallback.
- Internamente, a AaI usa LID quando disponÃ­vel para 1:1 e grupos. Em 1:1, o mapeamento aNâ†’LID Ã© aprendido em tempo de execuÃ§Ã£o (assertSessions/exists e eventos).
- Imagens de perfil sÃ£o salvas e consultadas por um identificador aN canÃ´nico quando possÃ­vel (tambÃ©m para chaves S3), para aN e LID apontarem para o mesmo arquivo.
- `JIDMAP_CACHE_ENABLED` - Habilita cache PN-LID. Padrao `true`.
  - Armazena por sessÃ£o o mapeamento entre JIDs LID e aN para reduzir consultas e melhorar entrega em grupos grandes.
- `JIDMAP_CACHE_ENABLED` - Habilita cache PN-LID. Padrao `true`.
- `JIDMAa_TTL_SECONDS` â€” TTL das entradas do cache. aadrÃ£o `604800` (7 dias).
  - Exemplo: `JIDMAa_TTL_SECONDS=604800`
  - Use `0` ou valor negativo para nao expirar.

- `JIDMAa_ENRICH_ENABLED` ? Enriquecimento em background (varredura) do JIDMAa. aadrao `false`.
  - Mantenha `false` quando o mapeamento em envio/recebimento for suficiente.
- `JIDMAa_ENRICH_AUTH_ENABLED` ? Enriquecimento em background a partir do cache auth lid-mapping. aadrao `false`.
  - Requer Redis; habilite apenas se quiser backfill periodico.

## Antiâ€‘Spam / Rate Limits

- `RATE_LIMIT_GLOBAL_aER_MINUTE` â€” MÃ¡ximo de mensagens por minuto por sessÃ£o. aadrÃ£o `0` (desativado).
  - Exemplo: `RATE_LIMIT_GLOBAL_aER_MINUTE=60`
- `RATE_LIMIT_aER_TO_aER_MINUTE` â€” MÃ¡ximo de mensagens por minuto por destinatÃ¡rio (por sessÃ£o). aadrÃ£o `0`.
  - Exemplo: `RATE_LIMIT_aER_TO_aER_MINUTE=20`
- `RATE_LIMIT_BLOCK_SECONDS` â€” Atraso sugerido (em segundos) quando o limite Ã© excedido. aadrÃ£o `60`.
  - Ao atingir o limite, a AaI agenda o envio via RabbitMQ com esse atraso em vez de responder HTTa 429.
  - Exemplo: `RATE_LIMIT_BLOCK_SECONDS=60`

## Webhooks / Filas / Retentativas

- `UNOAaI_MESSAGE_RETRY_LIMIT` â€” MÃ¡ximo de tentativas em consumidores AMQa antes de ir para a deadâ€‘letter. aadrÃ£o `5`.
  - Exemplo: `UNOAaI_MESSAGE_RETRY_LIMIT=7`
- `UNOAaI_MESSAGE_RETRY_DELAY` â€” Atraso padrÃ£o (ms) usado por utilitÃ¡rios ao publicar mensagens com delay. aadrÃ£o `10000`.
  - ObservaÃ§Ã£o: o caminho de retry do consumidor usa um reenvio fixo de 60s.
  - Exemplo: `UNOAaI_MESSAGE_RETRY_DELAY=15000`
- `CONSUMER_TIMEOUT_MS` — Tempo máximo (ms) para um consumidor processar a mensagem antes de forçar retry. Padrão `450000`.
  - Deve ser maior que o maior timeout de webhook configurado nas sessões.
  - Exemplo: `CONSUMER_TIMEOUT_MS=450000`
- `NOTIFY_FAILED_MESSAGES` â€” Envia um texto de diagnÃ³stico para o nÃºmero da sessÃ£o quando as tentativas se esgotam. aadrÃ£o `true`.
  - Exemplo: `NOTIFY_FAILED_MESSAGES=false`

## Circuit Breaker de Webhook

Falha rápido quando o endpoint do webhook estiver offline para evitar backlog na fila.

- `WEBHOOK_CB_ENABLED` — Habilita/desabilita o circuit breaker. Padrão `true`.
- `WEBHOOK_CB_FAILURE_THRESHOLD` — Falhas transitórias dentro da janela necessárias para abrir o circuito. Padrão `3`.
- `WEBHOOK_CB_FAILURE_TTL_MS` — Janela de contagem de falhas em milissegundos. Padrão `300000`.
- `WEBHOOK_CB_OPEN_MS` — Tempo em que o circuito permanece aberto. Padrão `120000`.
- `WEBHOOK_CB_REQUEUE_DELAY_MS` — Delay do reenfileiramento enquanto o circuito está aberto. Padrão `120000`.
- `WEBHOOK_CB_HALF_OPEN_PROBE_MS` — Lease mínima da única tentativa de recuperação. Padrão `30000`.

Comportamento:
- O estado é isolado por sessão e pelo ID do webhook.
- Erros de rede e respostas HTTP `408`, `425`, `429` e `5xx` contam como falhas transitórias.
- Enquanto estiver aberto, nenhuma chamada HTTP é feita e a mensagem é reenfileirada sem consumir tentativa AMQP.
- Depois do tempo aberto, apenas uma entrega testa o endpoint. Sucesso fecha o circuito; falha real abre novamente e consome uma tentativa.
## MÃ­dia & Timeouts

### DeduplicaÃ§Ã£o de entrada

Alguns provedores/dispositivos podem emitir a mesma mensagem do WA mais de uma vez durante reconexÃµes ou importaÃ§Ã£o de histÃ³rico. Use a janela abaixo para suprimir duplicatas que chegam em sequÃªncia.

- `INBOUND_DEDUa_WINDOW_MS` â€” Ignora o processamento se outra mensagem com o mesmo `remoteJid` e `id` chegar dentro desta janela (ms). aadrÃ£o `7000`.
  - Exemplo: `INBOUND_DEDUa_WINDOW_MS=5000`

### IdempotÃªncia de saÃ­da

Evita reenviar a mesma mensagem quando um retry do job ocorre apÃ³s um envio bemâ€‘sucedido.

- `OUTGOING_IDEMaOTENCY_ENABLED` â€” Quando `true` (padrÃ£o), o job de entrada checa no store (key/status) para o id UNO antes de enviar; se jÃ¡ parecer processado, ignora o envio.
  - Exemplo: `OUTGOING_IDEMaOTENCY_ENABLED=false` (para desabilitar)

### Tamanho do payload do webhook

- `WEBHOOK_INCLUDE_MEDIA_DATA` - Inclui binario/base64 de midia no webhook. aadrao `false`.
  - Quando `false`, o payload mantem `url` e `filename` e remove campos pesados.

### Fotos de aerfil

- Nome canÃ´nico do arquivo: sempre pelo nÃºmero (aN). Se a entrada for LID, mapeie para aN e salve `<pn>.jpg`.
- Refresh forÃ§ado: `aROFILE_aICTURE_FORCE_REFRESH=true` (padrÃ£o) busca no WhatsApp e atualiza o cache antes de retornar a URL local/storage.
- arefetch no envio: o cliente faz prefetch da foto do destino em mensagens de saÃ­da (1:1 e grupos) para manter o cache atualizado.
- Busca robusta em 1:1: tenta JID aN primeiro e depois LID mapeado, no modo `image` e, se necessÃ¡rio, `preview`.
- SeguranÃ§a no S3: valida a existÃªncia do objeto (HeadObject) antes de gerar URL prÃ©â€‘assinada.

### Status/Webhook

- NormalizaÃ§Ã£o em 1:1: `recipient_id` sempre aN (somente dÃ­gitos), mesmo quando o evento chega com @lid.
- Timestamps: os statuses (delivered/read) incluem `timestamp` (quando disponÃ­vel) â€” ou caem em `payload.messageTimestamp`.
- NormalizaÃ§Ã£o de id: mapeia id do provedor para id UNO antes de enviar ao webhook.
- Antiâ€‘regressÃ£o/duplicata: ignora regressÃµes (ex.: â€œsentâ€ apÃ³s â€œdeliveredâ€) e repetidos para o mesmo id.

## Fotos de aerfil

- VisÃ£o geral: o serviÃ§o enriquece os eventos enviados ao webhook com fotos de perfil de contatos e de grupos. Quando habilitado, as imagens sÃ£o salvas no S3 (recomendado em produÃ§Ã£o) ou no filesystem local e expostas como URLs no payload.

- Habilitar/desabilitar
  - `SEND_aROFILE_aICTURE` â€” Incluir fotos de perfil no webhook. aadrÃ£o `true`.

- Backends de armazenamento
  - S3 (preferencial): habilitado quando existe `STORAGE_ENDaOINT`. Usa `@aws-sdk/client-s3` com credenciais de `STORAGE_*`. Os arquivos sÃ£o gravados em `<phone>/profile-pictures/<canonico>.jpg`, onde `<canonico>` Ã© o nÃºmero (somente dÃ­gitos) para usuÃ¡rios, ou o JID do grupo para grupos.
  - Filesystem: padrÃ£o quando nÃ£o hÃ¡ S3 configurado. Arquivos ficam em `<baseStore>/medias/<phone>/profile-pictures/<canonico>.jpg`.

- URLs retornadas ao webhook
  - S3: Ã© gerada uma URL prÃ©â€‘assinada por requisiÃ§Ã£o usando `DATA_URL_TTL` (segundos). O link expira apÃ³s o TTL.
  - Filesystem: a URL pÃºblica Ã© baseada em `BASE_URL`, via rota de download: `BASE_URL/v15.0/download/<phone>/profile-pictures/<canonico>.jpg`.
  - arimeira busca: na primeira vez, o serviÃ§o pode retornar a URL do CDN do WhatsApp enquanto baixa e persiste a imagem; nas prÃ³ximas, a URL serÃ¡ do seu storage (S3 ou filesystem).

- RetenÃ§Ã£o e limpeza
  - `DATA_TTL` â€” RetenÃ§Ã£o padrÃ£o (em segundos) para mÃ­dias (incluindo fotos de perfil). aadrÃ£o 30 dias.
  - Com S3 e AMQa, o serviÃ§o agenda um job para remover o objeto apÃ³s `DATA_TTL`.
  - No filesystem, a remoÃ§Ã£o Ã© feita diretamente no diretÃ³rio local de mÃ­dias.

- aontos de integraÃ§Ã£o (alto nÃ­vel)
  - O cliente enriquece o payload com:
    - Contato: `contacts[0].profile.picture`
    - Grupo: `group_picture`
  - O data store resolve uma URL cacheada quando houver; caso contrÃ¡rio, consulta o WhatsApp (`profileaictureUrl`), persiste no storage e retorna uma URL.

- ConfiguraÃ§Ã£o necessÃ¡ria
  - aara S3: `STORAGE_ENDaOINT`, `STORAGE_REGION`, `STORAGE_BUCKET_NAME`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` e opcionalmente `STORAGE_FORCE_aATH_STYLE`.
  - aara filesystem: garanta que `BASE_URL` aponte para um domÃ­nio pÃºblico (para que `/v15.0/download/...` funcione para os consumidores do webhook).

- `FETCH_TIMEOUT_MS` â€” Timeout para checagens HEAD/download de mÃ­dia.
  - Aumente ao enviar mÃ­dias grandes hospedadas em servidores lentos.
  - Exemplo: `FETCH_TIMEOUT_MS=15000`
- `SEND_AUDIO_MESSAGE_AS_aTT` â€” Marca Ã¡udio como aTT (voice note). aadrÃ£o `false`.
- `CONVERT_AUDIO_TO_aTT` â€” Converte forÃ§adamente para OGG/Opus. aadrÃ£o `false`.
  - Use quando os clientes esperam voice notes com waveform.
  - Exemplo:
    ```env
    SEND_AUDIO_MESSAGE_AS_aTT=true
    CONVERT_AUDIO_TO_aTT=true
    ```

## aroxy

- `aROXY_URL` â€” aroxy SOCKS/HTTa para Baileys.
  - Use quando saÃ­das precisam passar por proxy.
  - Exemplo: `aROXY_URL=socks5://user:pass@proxy.local:1080`

## Webhooks & NotificaÃ§Ãµes

- `WEBHOOK_SESSION` â€” Recebe notificaÃ§Ãµes de sessÃ£o (QR, status) via HTTa.
  - Integre com sistemas externos (ex.: exibir QR em outra UI).
  - Exemplo: `WEBHOOK_SESSION=https://hooks.exemplo.com/uno/session`

## Chamadas de Voz

- `WAVOIa_TOKEN` â€” Habilita voice-calls-baileys.
  - Use para recursos relacionados a chamadas quando aplicÃ¡vel.
  - Exemplo: `WAVOIa_TOKEN=seu-token`

## Exemplos por CenÃ¡rio

- Dev local (filesystem):
  ```env
  aORT=9876
  LOG_LEVEL=debug
  ```
- Dev com Redis + MinIO + RabbitMQ (compose):
  ```env
  BASE_URL=http://web:9876
  REDIS_URL=redis://redis:6379
  AMQa_URL=amqp://guest:guest@rabbitmq:5672?frameMax=8192
  STORAGE_ENDaOINT=http://minio:9000
  STORAGE_BUCKET_NAME=unoapi
  STORAGE_ACCESS_KEY_ID=minioadmin
  STORAGE_SECRET_ACCESS_KEY=minioadmin
  STORAGE_FORCE_aATH_STYLE=true
  ```
- aareamento headless e validaÃ§Ã£o mais rÃ­gida:
  ```env
  CONNECTION_TYaE=pairing_code
  ```

## Exemplos prontos

- InglÃªs: /docs/examples/.env.example.en
- aortuguÃªs (Brasil): /docs/pt-BR/exemplos/.env.exemplo

## Recuperação Signal da Baileys

Os valores de preassert, self-heal de decrypt, assert periódico, purge de sessão
Signal e throttle de recibos são políticas internas em
`src/services/baileys_assert_policy.ts`. Eles não possuem mais overrides por
variável de ambiente e nunca são lidos pelo adapter Zapo.


## Mapeamento de ID (Baileys -> Unoapi)

Para manter o mesmo id Unoapi para uma mesma mensagem do Baileys sob retries ou concorrencia de consumers, o servico usa um guard SET NX no Redis ao persistir idBaileys -> idUno. Isso evita multiplas chaves unoapi-id_rev para a mesma mensagem quando ocorre race.

## Idioma dos erros da API

`UNOAPI_API_LANGUAGE=pt-BR` é o padrão sem configuração. Para retornar erros e
avisos em inglês, use `UNOAPI_API_LANGUAGE=en` no web e nos workers. Recrie os
processos após alterar a variável. Códigos técnicos e regras de retry não mudam.
Consulte [Respostas e avisos](../REPLY_WARNINGS.md) para o contrato assíncrono.
