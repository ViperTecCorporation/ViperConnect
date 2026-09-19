# Webhooks centralizados de sessões — contrato v1

Disponíveis no painel **Webhooks de sessões**, independentes de `webhooks[]` de
mensagens e de `sendConnectionStatus`. O recurso monitora sessões Zapo com Redis.
Não altera presença WhatsApp, reconexão, pareamento, áudio ou encaminhamento VoIP.

## Administração

Todas as rotas abaixo exigem o token **global** `UNOAPI_AUTH_TOKEN` no cabeçalho
`Authorization: Bearer ...`. Token individual de sessão não administra destinos.

| Método e rota | Resultado |
| --- | --- |
| GET `/admin/session-webhooks` | `{ "destinations": [...] }`, sem segredos |
| POST `/admin/session-webhooks` | Cria destino, HTTP 201 |
| PUT `/admin/session-webhooks/{id}` | Substitui campos não secretos, HTTP 200 |
| DELETE `/admin/session-webhooks/{id}` | Cancela destino, HTTP 204; preserva sessões |
| GET `/admin/session-webhooks/states` | `{ "states": [...] }`, últimas observações |

`states?destination_id=...` limita a consulta aos membros atuais do destino.
Sessão ainda não observada não aparece: ausência **não** prova desconexão.
Remoções permanecem na consulta sem filtro; após desvincular, não pertencem mais
à consulta filtrada. Não compartilhe o token global com integrações não confiáveis:
o ViperChat recebe os eventos por webhook, sem precisar desse token.

POST/PUT:

```json
{
  "name": "ViperChat principal",
  "url": "https://chat.example.com/hooks/session-status",
  "server": "server_1",
  "enabled": true,
  "session_ids": ["5511999999999"],
  "auto_include_new_sessions": false,
  "events": ["session.connected", "session.disconnected", "session.unlinked", "session.removed", "session.unavailable"],
  "heartbeat_interval_seconds": 300,
  "bearer_token": "token-exclusivo-do-receptor",
  "signing_secret": "substitua-por-um-segredo-aleatorio-de-32-ou-mais-caracteres"
}
```

- `signing_secret`: obrigatório na criação, mínimo 32 caracteres. Use segredo
  aleatório gerado com segurança. Omitir ao editar preserva o valor.
- `bearer_token`: opcional; omitir preserva, string vazia remove.
- Respostas incluem `id`, `revision`, `has_bearer_token`, `has_signing_secret`,
  nunca os valores secretos. Segredos ficam no Redis: proteja ACL, backups e TLS.
- Máximo 100 destinos e 1.000 sessões por destino; heartbeat entre 60 e 86.400 s.
- Somente HTTP(S), sem credenciais embutidas ou fragmento. HTTPS recomendado.
  Destinos internos são permitidos para instalações locais; somente administradores
  confiáveis devem controlar URLs. Não há redirecionamento HTTP.
- Seleção atual é explícita. Inclusão automática vale para sessões **novas** do
  servidor selecionado, inclusive com destino desabilitado. Desligá-la preservando
  `session_ids` não desfaz vínculos. O botão de selecionar todas atua nas atuais.
- Servidor é o limite disponível no core, **não uma conta ViperChat**. Se duas
  integrações compartilham servidor, use seleção explícita ou separe servidores
  antes de habilitar inclusão futura. A mesma sessão pode ter vários destinos.
- Editar muda `revision` e invalida entregas antigas pendentes; excluir/desabilitar
  também cancela futuras tentativas. HTTP já iniciado pode concluir. Reconciliar
  estado pelo endpoint de consulta após reconfiguração. Não há replay automático.
- Ao remover sessão, captura-se o evento com os destinatários anteriores e depois
  removem-se os vínculos. Recriar o número só o inclui novamente se a regra futura
  estiver ativa ou o administrador o selecionar.
  O snapshot antigo de uma sessão recriada passa a `unavailable`, com motivo
  `session_registered_pending_observation`, até uma nova observação do worker;
  isso não emite alerta de queda nem reutiliza a prova de conexão anterior.

## Payload entregue

```json
{
  "schema_version": 1,
  "event_id": "45f9b69f-2773-4508-94de-675d0f46ad74",
  "event": "session.unlinked",
  "occurred_at": "2026-09-19T05:40:00.000Z",
  "destination_id": "ade338c3-e67d-49f8-94ac-54684c63f8ec",
  "session": {"id": "5511999999999", "label": "Atendimento", "provider": "zapo", "server": "server_1"},
  "state": {"previous": "connected", "current": "unlinked", "changed_at": "2026-09-19T05:40:00.000Z", "sequence": 42},
  "connection": {
    "reason": "stream_error_device_removed", "code": null, "is_logout": true,
    "intentional": false, "reconnect_expected": false, "requires_pairing": true
  },
  "last_verified_at": "2026-09-19T05:40:00.000Z",
  "last_observed_at": "2026-09-19T05:40:00.000Z"
}
```

| Evento | Significado |
| --- | --- |
| `session.connected` | Socket aberto conforme evento Zapo; ou observação retomada após indisponibilidade |
| `session.disconnected` | Conexão caiu/foi encerrada; não comprova desvinculação |
| `session.unlinked` | Provider informou `isLogout=true`; precisa parear novamente |
| `session.removed` | Configuração removida da UnoAPI; não identifica quem removeu no telefone |
| `session.unavailable` | Nenhuma observação do worker conectado por mais de 120 s; estado remoto desconhecido |
| `session.heartbeat` | Opcional, snapshot local enquanto o worker se considera conectado |

`last_verified_at` é o último evento de conexão conhecido; não se renova com
heartbeat. `last_observed_at` é a observação local e não prova resposta recente
do WhatsApp. Campos sem evidência são `null`. `reconnect_expected` expressa a
intenção do fluxo, nunca garantia de recuperação. Heartbeats preservam
`state.changed_at`. `sequence` aumenta por sessão, inclusive em observações não
entregues; pode ter saltos. Datas são UTC ISO 8601. Não há QR, código de
pareamento, credenciais, tokens ou conteúdo de mensagens no payload.

## Recepção segura e ordenação

Headers:

- `X-ViperConnect-Event-Id`: mesmo `event_id` do corpo;
- `X-ViperConnect-Timestamp`: Unix em segundos, renovado a cada tentativa;
- `X-ViperConnect-Signature`: `sha256=<hex>`;
- `Authorization: Bearer ...`: somente quando configurado.

Assinatura: HMAC SHA-256 com `signing_secret` sobre
`timestamp + "." + corpo_original_UTF8`. Verifique os bytes originais antes de
parsear JSON, compare em tempo constante e rejeite timestamps fora de uma janela
de cinco minutos. Relógios devem estar sincronizados.

Persista/deduplique por `(destination_id, event_id)` e responda 2xx após aceitar
duravelmente. Para atualizar o status, aplique somente `state.sequence` superior
à já aplicada para a sessão: entregas podem se repetir e chegar fora de ordem.

## Filas, garantias e limites

Transição e snapshots entram atomicamente no Redis (`unoapi-session-webhooks:*`).
Na remoção, a exclusão da configuração participa da mesma operação Lua. Callback
tardio sem configuração não ressuscita estado. Um dispatcher no broker lê o
outbox em páginas e publica na fila exclusiva `<prefixo>.session.events`; remove
a entrada somente após confirmação RabbitMQ. HTTP usa prefetch 2 e timeout 10 s,
com o retry/dead-letter existente. Não recupera automaticamente a fila `.dead`.
Vários brokers podem publicar o mesmo snapshot; deduplicação é obrigatória.

O caminho do provider não aguarda HTTP nem confirmação AMQP. Observações locais
são persistidas em background e registram `SESSION_LIFECYCLE_PERSIST_FAILED`
quando falham. **Não há garantia de perda zero**: morte do processo antes de
persistir ou Redis indisponível pode perder uma transição. Heartbeat pode
restabelecer o snapshot conectado, não reconstruir todo o histórico.
Outbox já persistido sobrevive a reinício conforme a política de persistência
do Redis. Broker parado também interrompe monitoramento e entrega; um monitor
externo continua necessário para indisponibilidade de toda a instalação.

O dispatcher verifica a cada 5 s e o worker observa a cada 30 s. Heartbeat não
envia presença para WhatsApp. Estados removidos são tombstones persistentes;
não limpe seu contador enquanto consumidores dependerem da sequência.

## Documentação relacionada

Os testes `session_webhooks.ts`, `session_webhooks_controller.ts`,
`frontend/session_webhooks.ts` e `openapi_session_webhooks.ts` validam contrato,
assinatura, API e painel. O teste `session_webhooks_redis_integration.ts` é opt-in
por `SESSION_WEBHOOK_TEST_REDIS_URL`, exclusivamente localhost, banco 15 e servidor
descartável cujo diretório termina em `unoapi-session-webhooks-<identificador>`.
Ele limpa esse banco de teste; **nunca use Redis de produção**. Cobre Lua real,
inclusão futura, remoção atômica, heartbeat, callbacks antigos e retry do outbox.

- [Histórico e isolamento de filas](MESSAGE_HISTORY.md)
- [Blacklist PN/LID/grupos e TTL](WEBHOOK_BLACKLIST.md)
- [Provider e diagnóstico de desconexão](zapo-provider-migration.md)
- Contratos HTTP e schema: `docs/openapi.yaml`, JSON gerado e coleção Postman.
