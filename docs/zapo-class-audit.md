# Auditoria classe a classe: Baileys e Zapo

Data da revisao: 2026-07-21. Fonte Zapo validada: repositorio oficial
`vinikjkkj/zapo`, commit `2a415d9524365c986b1b11a4b10667b504e9ac92`, versao 1.6.1.

## Criterio

Cada arquivo de `src/controllers`, `src/jobs` e `src/services` foi classificado por
dependencia de provider. `comum` significa que o arquivo opera apenas com contratos
UnoAPI; `roteado` escolhe o provider; `baileys` e `zapo` sao implementacoes isoladas.
Arquivos compartilhados que ainda mencionam tipos WAProto podem ser usados pela Zapo
somente quando o protocolo oficial garante o mesmo contrato, nunca para acessar socket,
Signal ou store da Baileys.

## Controllers

Todos os controllers permanecem comuns e chamam `Incoming`/`Client`; nenhum instancia
Baileys ou Zapo. Revisados:

- `blacklist_controller`, `connect_controller`, `contacts_controller`,
  `embedded_controller`, `index_controller`, `jidmap_controller`,
  `marketing_messages_controller`, `media_controller`, `messages_controller`,
  `pairing_code_controller`, `passkey_bridge_controller`, `phone_number_controller`,
  `preflight_controller`, `registration_controller`, `session_controller`,
  `templates_controller`, `timer_controller`, `webhook_controller` e
  `webhook_fake_controller`.

Decisoes:

- `messages_controller`: Status usa `StatusRecipients`, um ZSET temporal por sessao;
  nao varre mais milhares de chaves permanentes de contato.
- `groups_controller`: a saida aceita os campos oficiais `jid`, `lid`, `phoneNumber`,
  `username` e `displayName`; Redis e apenas fallback para registros Baileys antigos.
- `phone_number_controller`: app-state, historico e privacy token delegam ao coordinator
  oficial do provider.
- `passkey_bridge_controller`: atende Baileys e o signer externo oficial da Zapo.

## Jobs

Comuns e sem protocolo: `add_to_blacklist`, `broadcast`, `bulk_parser`, `bulk_report`,
`bulk_sender`, `bulk_status`, `bulk_webhook`, `commander`, `contact_sync`, `incoming`,
`logout`, `media`, `notification`, `outgoing`, `reload`, `timer`, `transcriber` e
`webhook_status_failed`.

Roteados:

- `bind_bridge`: vincula apenas sessoes do `UNOAPI_WORKER_ENGINE` atual e usa
  `ProviderListener` no retorno.
- `listener`: deixou de descartar sessoes Zapo; desempacota WAProto e entrega ao
  listener selecionado pela configuracao da sessao.

## Contratos e infraestrutura comuns

Revisados sem mudanca de provider: `blacklist`, `broadcast`, `broadcast_amqp`,
`coexistence_window`, `config`, `config_by_env`, `config_redis`, `contact`,
`contact_dummy`, `contact_incoming`, `embedded_tokens`, `graph_error`, `incoming`,
`incoming_amqp`, `inject_route`, `inject_route_dummy`, `listener`, `logger`, `logout`,
`logout_amqp`, `message_filter`, `meta_alias`, `meta_ids`, `middleware`,
`middleware_next`, `on_new_login_alert`, `on_new_login_generate_token`, `outgoing`,
`outgoing_amqp`, `outgoing_cloud_api`, `rate_limit`, `reload`, `reload_amqp`, `response`,
`restriction_notice`, `security`, `send_error`, `session`, `session_file`,
`session_redis`, `session_store`, `session_store_file`, `session_store_redis`, `store`,
`store_file`, `store_redis`, `template` e `timer`.

## Selecao e lifecycle

- `client`: contrato comum, com capabilities opcionais explicitas.
- `client_factory`: seleciona `ClientBaileys` ou `ClientZapo` por sessao.
- `provider_types`, `provider_resolver`, `provider_queue`, `cloud_process_role`:
  configuracao e filas separadas por motor.
- `incoming_provider`: fachada comum de endpoints para qualquer `Client`.
- `incoming_baileys`: preserva apenas o nome/export legado; a implementacao passou a
  ser `IncomingProvider`.
- `listener_router`: seleciona `ListenerBaileys` ou `ListenerZapo` inclusive depois da
  fila AMQP.
- `auto_connect`, `reload_baileys`, `logout_baileys` e `contact_baileys`: nomes legados,
  mas obtencao do cliente passa pela factory; nao forcam motor em sessao Zapo.

## Implementacao isolada Baileys

- `auth_state`, `client_baileys`, `listener_baileys`, `socket`, `error_utils`,
  `client_coexistence`, `privacy_bootstrap_sync`,
  `privacy_token_debug` e `privacy_token_quota`.
- Assert de sessoes Signal, device-list, retry de erro 463, decriptacao local de voto,
  hacks PN/LID e recuperacao forcada de sessao ficam confinados aqui.
- `baileys_snapshot` e somente leitor da origem durante a migracao; nunca altera ou
  apaga credenciais Baileys.

## Implementacao isolada Zapo

- `client_zapo`: conexao, QR/pairing, eventos oficiais, VoIP, app-state, historico,
  contatos, media e delegacao.
- `listener_zapo`: deduplicacao, ID externo Uno, transformacao Cloud API, media e
  progressao de receipts sem executar hacks Baileys.
- `zapo_store` e `zapo_store_registry`: stores oficiais Redis/SQLite, prefixo isolado e TTL por dominio; auth principal e persistente e material criptografico inativo expira em 90 dias.
- `zapo_migration`, `zapo_snapshot`: migracao idempotente e validacao do destino.
- `zapo_identity`: normalizacao BR na borda, PN para LID via contact store/profile e
  LID como identidade canonica.
- `zapo_username_index`: aliases aprendidos de envelopes, grupos e eventos MEX;
  remocao acompanha `username_delete`.
- `zapo_messages`: typed send, quoting, edit, revoke, receipts, retry idempotente,
  presenca e Status.
- `passkey_bridge`: contrato HTTP/Redis comum; na Zapo alimenta diretamente o callback
  oficial `signPasskeyAssertion`.
- `zapo_message_mapper`: texto, midia, contato e Proto nativo para lista, botao e
  carousel interativo.
- `zapo_groups`: todas as mutacoes resolvem participantes para LID antes do coordinator.
- `zapo_events`: message, receipts em lote e addons ja decriptados pela Zapo.

## Compartilhados revisados

- `transformer` e `transformer/*`: permanecem fachada publica Cloud API. A Zapo entrega
  `Proto.IMessage`, logo o mapper de conteudo e reutilizado; nenhuma chamada de socket,
  assert Signal ou Redis foi adicionada ao transformer. PN fica em `wa_id/from` e LID em
  `user_id/from_user_id`.
- `data_store`, `data_store_file`, `data_store_redis`: conservam somente IDs externos,
  status, media e compatibilidade historica. Store de contato/sessao Zapo e o oficial.
- `redis`: o store oficial Zapo e fonte dos dominios nativos. Redis Uno conserva configuracao,
  IDs publicos, lease distribuida, indice compacto de destinatarios de Status e alias temporal
  de username. O alias usa ZSET auxiliar para expirar campos mesmo em sessoes ativas; a
  manutencao incremental remove IDs orfaos dos indices oficiais de mensagens.
- `media_store`, `media_store_file`, `media_store_s3`: persistencia comum. Download e
  upload Zapo usam `client.message.downloadBytes/upload`; o buffer baixado entra direto
  no storage, sem decriptador Baileys nem conversao base64 intermediaria.
- `groups/group_metadata_cache`: cache de resposta HTTP; metadata Zapo e sincronizada
  pelo coordinator oficial.

## Defaults

- Comuns: HTTP/webhook, filas, storage, rate limit, media persistida e cache temporal.
- Zapo: selecao de motor, TTLs dos stores oficiais, passkey bridge e destinatarios de
  Status.
- Baileys-only: WAM, Signal/assert, watchdog, JIDMAP, addressing e retry. Permanecem
  enquanto o worker Baileys existir e nao sao lidos pelo adapter Zapo.
- Removidos por nao terem consumidor: `UNOAPI_URL`, `REDIS_KEYS_USE_SCAN`,
  `UNOAPI_QUEUE_DELAYED`, `UNOAPI_QUEUE_BLACKLIST_RELOAD`, `UNOAPI_QUEUE_CONTACT`,
  `GROUP_SEND_RETRY_ON_421` e o alias duplicado `CONVERT_AUDIO_TO_PTT`.
- Corrigida a leitura invertida de `VALIDATE_MEDIA_LINK_BEFORE_SEND`,
  `PERIODIC_ASSERT_INCLUDE_GROUPS` e `ONE_TO_ONE_ASSERT_PROBE_ENABLED`.

## Eventos oficiais cobertos

`auth_qr`, `auth_pairing_required`, `auth_pairing_code`, `connection`, `message`,
`message_send`, `message_addon`, `receipt`, `group`, `mex_notification` e
`voip_call_incoming`. History sync e app-state sao persistidos pelos stores/coordinators
oficiais. Presence e Status usam coordinators dedicados.

Eventos de newsletter, bot streaming e broadcast-list permanecem fora da liberacao Zapo
ate os respectivos endpoints e testes de contrato existirem.
