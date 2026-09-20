# Webhooks de sessões

O menu **Webhooks de sessões** do painel configura destinos centralizados para
monitorar sessões Zapo. Este contrato é separado dos webhooks de mensagens e não
altera `webhooks[]`, `sendConnectionStatus`, presença WhatsApp ou VoIP.

## Configurar um destino

Use o token administrativo global em `Authorization: Bearer ...`:

| Rota | Uso |
| --- | --- |
| GET `/admin/session-webhooks` | Listar destinos, sem segredos |
| POST `/admin/session-webhooks` | Criar (201) |
| PUT `/admin/session-webhooks/{id}` | Substituir configuração (200) |
| DELETE `/admin/session-webhooks/{id}` | Excluir destino, preservando sessões (204) |
| GET `/admin/session-webhooks/states` | Consultar observações; filtro opcional `destination_id` |

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
  "signing_secret": "use-um-segredo-aleatorio-com-32-ou-mais-caracteres"
}
```

`bearer_token` e `signing_secret` são opcionais e independentes. Sem segredo na
criação, o webhook é enviado sem assinatura HMAC. Omitir segredos no PUT preserva
os valores; string vazia remove o respectivo segredo. HMAC, quando informado,
exige pelo menos 32 caracteres. No painel, use **Remover assinatura HMAC** ao editar.
Para um fluxo n8n sem validação HMAC, deixe o segredo vazio na criação.
Prefira HTTPS e Bearer quando suportado. A resposta
informa `has_bearer_token` e `has_signing_secret`, nunca os segredos.

Selecione sessões atuais explicitamente. **Vincular automaticamente novas sessões**
só inclui sessões criadas posteriormente nesse servidor. Desligar a opção não
remove membros quando `session_ids` é preservado. Vários destinos podem acompanhar
a mesma sessão. Ao remover uma sessão, o evento guarda seus destinatários antes
de desfazer os vínculos. Recriação não restaura seleções antigas automaticamente.
O snapshot anterior de uma sessão recriada fica `unavailable`, motivo
`session_registered_pending_observation`, até o worker observar a nova conexão.
Não é emitido alerta de queda para esse estado inicial.

::: warning Limite entre integrações
O escopo é o servidor UnoAPI, não uma conta ViperChat. Se várias integrações usam
o mesmo servidor, prefira seleção explícita ou separe os servidores. Não entregue
o token global ao receptor: receber webhook não requer acesso administrativo.
:::

Editar um destino invalida entregas pendentes da revisão anterior. Excluir ou
desabilitar também cancela novas tentativas; um HTTP já iniciado pode concluir.
Use a consulta de estado para reconciliação após mudanças. Máximo 100 destinos,
1.000 sessões por destino e heartbeat entre 60 e 86.400 segundos.

## Eventos e envelope

| Evento | Significado |
| --- | --- |
| `session.connected` | Provider abriu conexão ou observação local foi retomada |
| `session.disconnected` | Queda/encerramento sem comprovação de desvinculação |
| `session.unlinked` | Provider reportou logout; exige novo pareamento |
| `session.removed` | Sessão removida da UnoAPI |
| `session.unavailable` | Worker deixou de observar uma sessão conectada por mais de 120 s |
| `session.heartbeat` | Snapshot local opcional enquanto o worker se considera conectado |

```json
{
  "schema_version": 1,
  "event_id": "45f9b69f-2773-4508-94de-675d0f46ad74",
  "event": "session.unlinked",
  "occurred_at": "2026-09-19T05:40:00.000Z",
  "destination_id": "ade338c3-e67d-49f8-94ac-54684c63f8ec",
  "session": {"id": "5511999999999", "label": "Atendimento", "provider": "zapo", "server": "server_1"},
  "state": {"previous": "connected", "current": "unlinked", "changed_at": "2026-09-19T05:40:00.000Z", "sequence": 42},
  "connection": {"reason": "stream_error_device_removed", "code": null, "is_logout": true, "intentional": false, "reconnect_expected": false, "requires_pairing": true},
  "last_verified_at": "2026-09-19T05:40:00.000Z",
  "last_observed_at": "2026-09-19T05:40:00.000Z"
}
```

Campos sem evidência são `null`. Heartbeat não renova `last_verified_at`: observação
local não prova resposta do WhatsApp. `reconnect_expected` não garante sucesso.
`state.sequence` é monotônica por sessão e pode ter saltos. Não há QR, pareamento,
credenciais ou conteúdo de mensagens. A consulta inclui somente sessões já
observadas; ausência não indica desconexão. Tombstones de removidas aparecem na
consulta sem filtro, mas não nos membros atuais do destino.

## Validar assinatura e receber

Somente com segredo configurado a UnoAPI gera e envia o header de assinatura.
Sem HMAC, os headers de timestamp e ID do evento continuam presentes.
Quando habilitado, verifique `X-ViperConnect-Signature: sha256=<hex>` calculando HMAC SHA-256 com o
segredo sobre `X-ViperConnect-Timestamp + "." + corpo_original_UTF8`.
Timestamp é Unix em segundos, renovado por tentativa. Use comparação em tempo
constante e janela de cinco minutos. `X-ViperConnect-Event-Id` repete o ID do corpo.
Bearer só é enviado se configurado. HTTP(S) é aceito, HTTPS recomendado; não há
redirecionamento. URLs internas exigem administradores confiáveis.

Deduplicate por `(destination_id, event_id)` e só aplique estado com sequência
superior à última aplicada. Responda 2xx após aceitar duravelmente. Outbox Redis
e fila exclusiva `<prefixo>.session.events` isolam essa entrega; timeout de 10 s,
prefetch 2, retry/dead-letter existente, sem recuperação automática de `.dead`.

Não há garantia de perda zero antes da persistência: falha Redis ou morte do
worker pode perder transição. Observe `SESSION_LIFECYCLE_PERSIST_FAILED` e
`SESSION_WEBHOOK_OUTBOX_RETRY`. Múltiplos brokers podem duplicar entregas.
Monitoramento depende do broker; mantenha monitor externo para queda total.

Veja schemas completos na [referência HTTP](/api-reference) e o documento
[SESSION_WEBHOOKS.md](https://github.com/ViperTecCorporation/ViperConnect/blob/main/docs/SESSION_WEBHOOKS.md).
