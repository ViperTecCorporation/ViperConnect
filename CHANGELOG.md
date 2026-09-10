# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and follows SemVer when applicable.

## [Unreleased]

- Feat(JIDMAP API): adicionar endpoints para inspecionar mapeamentos PN↔LID por sessão
  - GET `/:version/:phone/jidmap` — lista pares `pn_for_lid` e `lid_for_pn` (inclui chaves antigas `pn:`/`lid:`)
    - Suporta filtros/paginação: `side=pn_for_lid|lid_for_pn|all`, `q=<substring>`, `limit`, `offset`
  - GET `/:version/:phone/jidmap/:contact` — lookup direto por contato `@lid` ou PN (dígitos ou `@s.whatsapp.net`)
  - Útil para auditar duplicidades PN vs LID (Chatwoot) e depurar aquecimento de cache
- Feat(JIDMAP 1:1): enriquecer PN↔LID fora de grupos
  - listener_baileys: inbound @lid em 1:1 tenta `getPnForLid` quando não há PN válido e persiste mapping
  - data_store_file.loadJid: normaliza @lid → PN para `onWhatsApp` (Baileys v7) e reflete PN↔LID quando resolver
  - socket: handler de `lid-mapping.update` mais robusto (classificação via `isPnUser/isLidUser` + fallback `jidNormalizedUser`)
  - data_store_file.getPnForLid: deriva PN via `jidNormalizedUser` quando o cache local estiver vazio
- Feat(Webhook PN-first): quando preferir PN e não houver cache/contact-info, normaliza @lid → PN via `jidNormalizedUser` (valida E.164) antes de enviar
- Feat(Mentions): substitui `@<digits>` por `@<nome>` mesmo sem `mentionedJid`, consultando `contact-name/contact-info` (grupos e 1:1)
- Fix(Logs 1:1): log “forçando PN …” só aparece quando há PN JID válido; caso contrário mantém LID e registra preferência sem mapping
- Build: elevar heap do Node no build TypeScript (`--max-old-space-size=4096`) para evitar OOM

- Status/Webhook (1:1)
  - recipient_id sempre em número (PN), mesmo quando o evento chega com @lid
  - inclui timestamp em statuses (delivered/read) e normaliza id do status (provider → UNO)
  - filtro anti-regressão/duplicata: evita “sent” depois de “delivered/read” e ignora duplicatas
- Mensagens de grupo via API (cópia no webhook)
  - sempre notifica “new message” de grupos e adiciona `contacts[0].group_id = to`
  - fallback quando o provedor não retorna id (usa `idUno`)
- Recusa de chamadas (call)
  - prioriza PN no webhook (wa_id/from) usando mapeamentos; logs detalhados (CALL event/mapping)
- Fotos de perfil (FS/S3)
  - nome de arquivo sempre por PN (ex.: `5566996269251.jpg`), mapeando LID→PN antes de salvar
  - refresh de cache ao consultar (`PROFILE_PICTURE_FORCE_REFRESH=true`), prefetch no envio
  - busca robusta PN/LID (image→preview) e HeadObject no S3 antes de presign
- Pipeline de saída
  - idempotência (`OUTGOING_IDEMPOTENCY_ENABLED=true`) evita reenvio em retries
  - remove delay do webhook “sent” e não envia se já houver status avançado
- Estabilidade/Logs
  - remove JSON.stringify de objetos WAProto (evita `long.isZero`), loga apenas chaves/tipo
  - deduplicação leve de entrada (`INBOUND_DEDUP_WINDOW_MS`)
  - logs BAILEYS para `messages.update`/`message-receipt.update` e decisões de status (forward/regression/duplicate)

- Fix: prevent recursive overflow when handling `editedMessage` and device-sent updates in `fromBaileysMessageContent` by unwrapping and dropping the `update` field before recursion.
- Feat: default group sends to LID addressing; pre-assert sessions prioritizing LIDs; add robust fallback for libsignal "No sessions" and ack 421 with adaptive waits and addressingMode toggling.
- Feat: 1:1 sends actively learn PN→LID (assertSessions + exists) and use LID internally when available; detailed debug logs for learning path.
- Feat: PN↔LID mapping cache in File and Redis stores with TTL; derive PN from LID via Baileys normalization when missing, and persist mapping both ways.
- Feat: profile pictures use canonical PN for filenames/keys (FS and S3); getters/setters consider PN and LID variants and log fallbacks.
- Docs: update README and environment/architecture docs (PT-BR and EN) to describe LID/PN behavior, group addressing, webhook PN-first policy, and profile picture canonicalization.

## [4.0.31] - 2026-09-10

- Atualiza Zapo para 1.8.2, preservando o vendor VoIP 1.0.0-viper.6.
- Aplica alteracoes exclusivas de webhook sem reconectar a sessao.
- Corrige lifecycle de reconexao, QR e codigo de pareamento com prazos limitados.
- Envia pulso de presenca ao conectar e a cada tres horas, restaurando unavailable
  quando markOnlineOnConnect estiver desativado.
- Mantem estado criptografico e privacidade persistentes no Redis, remove as
  antigas ENVs de TTL e migra chaves existentes com SCAN/PERSIST antes do socket.
- Incorpora motor VoIP 0.1.65, revisao 8fb39da48a7c98ff97f104ea46a46775ac5c3f5e.

## [4.0.30] - 2026-08-28

### Fixed

- Normaliza a saída PCM variável do decoder Zapo em quadros exatos de 960
  amostras antes do bridge VoIP, evitando chamadas mudas quando um pacote
  decodificado produz mais de um quadro.
- Acumula fragmentos curtos sem completar com silêncio, preserva a ordem e
  isola qualquer resto por chamada.
- Separa erros de entrega PCM de erros SRTP para evitar diagnóstico incorreto
  depois que autenticação e decode já foram concluídos.

### Observability and validation

- Inclui `pcmDeliveredFrames`, `pcmDeliveryErrors` e `pcmPendingSamples` em
  `call stats`.
- Validação ao vivo: quatro chamadas com iPhone 16/Galaxy S9e e uma chamada
  para o destinatário que reproduzia a falha, todas bidirecionais e sem erro
  SRTP, Opus ou bridge.
- O caso problemático converteu 474 decodes em 787 quadros válidos; os mesmos
  787 quadros chegaram ao serviço VoIP sem perda.

## 3.0.0-beta-81

- Fix(webhook/status): padroniza `wa_id`/`recipient_id` como PN (somente dígitos) e corrige URL do webhook para terminar com `:phone_number_id` da sessão.
  - Evita ficar travado em “sent” no Chatwoot por inbox errada ou recipient invertido.
  - Ajuste defensivo: se `recipient_id` vier vazio/igual ao canal, força PN do outro lado.
- Fix(conversation.id): reverte `conversation.id` para o JID da conversa (compatibilidade com testes), mantendo PN nos campos críticos.
- Fix(status/duplicate): não persiste status antes de decidir enviar; persiste somente após envio para evitar auto-skip como duplicata.
- Fix(logging/WAMessage): remove JSON.stringify de objetos WAProto em todos os caminhos (send/receive/eventos), logando apenas (jid,id,tipo/status).
  - Mitiga “TypeError: this.isZero is not a function” (Long/WAProto).
- Feat(storage/WAMessage): armazena mensagens como protobuf base64 (WebMessageInfo.encode) no Redis e File Store.
  - `getMessage` decodifica base64; compatível com JSON legado; fallback para JSON mínimo em caso de falha.
- Fix(AMQP bridge): empacota WAMessage como protobuf base64 somente para tipos `message|notify|qrcode|append|history`.
  - Não empacotar `update/receipt/delete/status` (preserva campo `update`); evita “Unknown baileys message type undefined”.
  - Consumer passa mensagens decodificadas (`a.messages`) para o listener (corrige regressão que interrompia envio/recebimento).
- Fix(tests/compat): mantém `profile.picture` em mensagens novas e suprime em updates quando apropriado, para não gerar `picture: undefined` em testes de status.
- Chore: logs de eventos (upsert/update/receipt/delete) resumidos (count+sample) para diagnósticos sem serializar WAProto.

## 3.0.0-beta-57

- Feat(groups): reduce webhook/socket fan-out for group receipts/status
  - New env flags (default true): `GROUP_IGNORE_INDIVIDUAL_RECEIPTS`, `GROUP_ONLY_DELIVERED_STATUS`
  - Ignore `message-receipt.update` per participant in groups; forward only group-level `DELIVERY_ACK` via `messages.update` when enabled
  - Docs: sections added in EN/PT-BR and .env.example updated
- Fix(calls): rejected call notify webhook now returns PN instead of LID
  - Send `key.senderPn` in the synthetic notify event; transformer prioritizes PN for `contacts[0].wa_id` and `messages[0].from`
- Fix(decrypt): forward a structured payload to webhook on decrypt failures (DecryptError)
  - Prevents silent drops and helps clients guide end-users (e.g., open WhatsApp on phone)
- Fix(webhook): lightweight inbound deduplication to avoid duplicates during reconnect/history import
  - New `INBOUND_DEDUP_WINDOW_MS` (default 7000ms); skip same `remoteJid|id` seen within the window
- Chore: bump version to 3.0.0-beta-57

## 3.0.0-beta-58

- Fix(status 1:1): map provider id to UNO id in `message-receipt.update` for correct delivered/read correlation
  - Ensures webhook status updates use the same id returned on send; avoids stuck “delivered” or missing “read” in 1:1
  - Applies id normalization before emitting the webhook (ListenerBaileys)
- Chore: version bump to 3.0.0-beta-58

## 3.0.0-beta-59

- Fix(logging): avoid JSON.stringify on WAProto (WAMessage) objects to prevent `long.isZero` runtime error
  - Sanitize logs in sender/listener to print jid/id/type instead of full WAProto objects
  - Prevents false negatives that caused job retries and duplicate sends
- Feat(outgoing): idempotency guard for job retries
  - New `OUTGOING_IDEMPOTENCY_ENABLED` (default true). Incoming job checks store (key/status) for UNO id and skips resend if already processed
- Chore: bump version to 3.0.0-beta-59

## 3.0.0-beta-60

- Feat(profile): canonicalize profile picture filenames to phone number (PN) and support refresh
  - Always store filenames as `<pn>.jpg` (e.g., `5566996269251.jpg`), mapping LID→PN when needed
  - Add `PROFILE_PICTURE_FORCE_REFRESH` (default true) to refresh cache by fetching from WhatsApp before returning URL
  - Ensure S3/FS `getProfilePictureUrl` resolves LID→PN and returns URL named by PN
- Fix(webhook): include profile picture for updates/receipts using local cache
  - Enrich `contacts[0].profile.picture` on update/receipt payloads when `sendProfilePicture` is enabled

## 3.0.0-beta-61

- Feat(profile): prefetch profile pictures on send and add detailed logs
  - On every outbound send (1:1/group) prefetches profile picture to refresh storage cache proactively
  - Logs: prefetch start/done, lookup, cache hit, fetched-from-WA, persisted local URL, and FS/S3 saves
- Fix(build): imports and listener config access
  - data_store_file: import `ensurePn` and `PROFILE_PICTURE_FORCE_REFRESH`
  - listener_baileys: use runtime `config` instead of `this.config`

## 3.0.0-beta-64

- Fix(profile/1:1): robust fetch of profile pictures
  - Tries PN JID first, then mapped LID JID (image → preview), persists only as `<pn>.jpg`
  - Logs added for prefetch, lookup, fetch and persist; S3 existence check before presign
- Fix(logging): avoid JSON.stringify of WAProto-like content during send to prevent `long.isZero` errors
- Misc: minor build fixes and stability improvements

## 3.0.0-beta-52

- Feat: add Groq-based audio transcription provider (OpenAI-compatible endpoint at `/audio/transcriptions`) with priority order Groq → OpenAI → local Whisper (`audio2textjs`).
- Feat: per-session Groq configuration persisted in Redis and prioritized over env:
  - `groqApiKey`, `groqApiTranscribeModel` (default `whisper-large-v3`), `groqApiBaseUrl` (default `https://api.groq.com/openai/v1`).
- Config: new environment variables wired into config loader:
  - `GROQ_API_KEY`, `GROQ_API_TRANSCRIBE_MODEL`, `GROQ_API_BASE_URL`.
- UI: add Groq fields to the session config modal in `public/index.html` (`Groq API Key`, `Groq Transcribe Model`, `Groq API Base URL`) with i18n (EN/PT-BR).
- Docs: add transcription guides `docs/TRANSCRIPTION_AUDIO.md` (EN) and `docs/pt-BR/TRANSCRICAO_AUDIO.md` (PT-BR); linked new section "Audio Transcription" in `public/docs/index.html`.

---

## 3.0.0-beta-47

- Baseline version referenced by users; subsequent fixes and features listed under Unreleased.

