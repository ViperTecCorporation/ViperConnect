# Plano de retomada: telemetria WAM Baileys

## Contexto

A Uno usa Baileys como camada WhatsApp Web. A telemetria WAM/w:stats foi adicionada para aproximar o envelope/comportamento do WhatsApp Web e ajudar nas investigacoes de:

- erro `463` / restricao MEX;
- recuperacao de `tctoken`, `cstoken` e `nct_salt`;
- diferencas de envelope entre Baileys, Zapo e whatsmeow;
- comportamento por sessao em producao.

## Estado atual

Baileys:

- coleta eventos WAM basicos de conexao, stream mode, recebimento, receipt e stanzas desconhecidos;
- envia o buffer WAM para `w:stats` usando `sendNode` fire-and-forget;
- reagenda flush se novos eventos chegam durante um flush em andamento;
- ignora `ack` generico para evitar `UnknownStanza` falso;
- controla log de evento individual por `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS`.

Uno:

- habilita WAM por padrao;
- repassa as configuracoes para o socket Baileys;
- mantem log resumido em producao.

## Envs

```env
BAILEYS_WAM_TELEMETRY=true
BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=false
BAILEYS_WAM_TELEMETRY_FLUSH_MS=5000
BAILEYS_WAM_TELEMETRY_MAX_EVENTS=50
```

Use `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=true` apenas para janela curta de diagnostico, porque gera `WAM_TELEMETRY_COMMIT` para cada evento.

## Validacao rapida em VPS

```bash
docker logs --since=5m unoapi 2>&1 \
  | grep -E 'WAM_TELEMETRY_ENABLED|WAM_TELEMETRY_FLUSH|WAM_TELEMETRY_SEND_OK|WAM_TELEMETRY_SEND_ERROR|UnknownStanza' \
  | tail -120
```

Esperado:

- `WAM_TELEMETRY_ENABLED` ao abrir cada sessao;
- `WAM_TELEMETRY_FLUSH` seguido de `WAM_TELEMETRY_SEND_OK`;
- ausencia de `WAM_TELEMETRY_SEND_ERROR` recorrente;
- ausencia de `UnknownStanza` recorrente para `ack`.

Contagem resumida:

```bash
tmp=/tmp/uno-wam.log
docker logs --since=10m unoapi > "$tmp" 2>&1
printf 'SEND_ERROR='; grep -c WAM_TELEMETRY_SEND_ERROR "$tmp" || true
printf 'SEND_OK='; grep -c WAM_TELEMETRY_SEND_OK "$tmp" || true
printf 'FLUSH='; grep -c WAM_TELEMETRY_FLUSH "$tmp" || true
printf 'UNKNOWN_STANZA='; grep -c UnknownStanza "$tmp" || true
```

## Backlog sugerido

### 1. Reduzir ruido de log

Status: implementado.

Manter `WAM_TELEMETRY_COMMIT` condicionado a `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=true`. Em producao, observar apenas `ENABLED`, `FLUSH`, `SEND_OK` e `SEND_ERROR`.

### 2. Metrica resumida por sessao na Uno

Implementar um resumo periodico por sessao com:

- total de eventos WAM coletados;
- total de flushes enviados;
- ultimo `SEND_OK`;
- ultimo `SEND_ERROR`;
- quantidade de `UnknownStanza`;
- timestamp do ultimo evento.

Objetivo: saber se a sessao esta emitindo telemetria sem depender de log bruto.

### 3. Eventos WAM ligados a envio e erro

Adicionar eventos/props para comparar sessoes boas e ruins em casos de `463`:

- envio iniciado;
- envio aceito pelo servidor;
- envio falhou com codigo;
- fallback PN/LID;
- erro `463`;
- erro `401`;
- erro `408`;
- recuperacao ou ausencia de token de privacidade.

Objetivo: gerar evidencia comparavel entre Baileys, Zapo e whatsmeow sem mudar o comportamento de envio.

## Guard operacional sem TC token

Implementado na Uno como protecao por sessao:

- `UNOAPI_MISSING_TC_TOKEN_GUARD_ENABLED=true`
- `UNOAPI_MISSING_TC_TOKEN_LIMIT=40`
- `UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS=24`

Fluxo:

1. Antes do envio 1:1, `ClientBaileys` verifica no auth store se existe `tctoken` valido para PN/LID candidatos.
2. Se nao houver `tctoken`, consulta a quota em Redis (`ZSET` por sessao, janela movel).
3. Se `used < limit`, envia normalmente; a Baileys ainda pode recuperar `tctoken` durante o fluxo real.
4. Se `used >= limit`, a Uno chama `ensurePrivacyTokens()` na Baileys para tentar recuperar e armazenar `tctoken` no auth store.
5. Se recuperar `tctoken`, envia normalmente e nao conta como envio sem `tc`.
6. Se continuar sem `tctoken`, nao chama `sendMessage`; retorna `failed` com `reason=missing_tc_token_quota_exceeded`.
7. Se enviar sem `tctoken`, registra o envio no ZSET e anexa `privacy_token` em `ok.messages[0]`.
8. `/sessions` retorna `missing_tc_token_quota` para o frontend exibir `usado/limite`.

Observacao: envio com `cstoken` ainda conta como "sem tc token", porque a politica foi desenhada para limitar especificamente mensagens sem `tctoken`.

## Cuidados

- Nao reativar `query()` para WAM. O envio deve continuar fire-and-forget com `sendNode`, pois o servidor nao respondeu de forma confiavel e causava timeouts `408`.
- Nao deixar `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=true` como default em imagem de producao.
- Ao publicar Baileys, garantir que a Uno atualize a referencia do branch compilado `Main` e rode `yarn install` para atualizar o lock.
