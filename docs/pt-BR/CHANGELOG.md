# Changelog (PT-BR)

Todas as mudanças notáveis neste projeto serão documentadas aqui.

O formato segue o Keep a Changelog e adota SemVer quando aplicável.

## [4.0.35] - 2026-10-08

- Confirmação no aparelho: consulta explícita de `/exist` com as mesmas chaves, sem novo SMS/ligação, liberando a conexão após resposta afirmativa.
- Preservação do nono dígito no identificador da sessão, API, Redis e webhooks; autenticação mantém o número canônico confirmado pelo WhatsApp. Backup, restore, exclusão e dispositivos vinculados respeitam a separação.
- Correções de backup/restauração de sessões grandes, processamento em streaming, upload multipart e retorno de progresso/erros no painel.
- Atualização fixada da biblioteca de registro e alinhamento do validador da imagem; preservação de metadados nas recusas e respeito aos prazos independentes de SMS/voz.
- Guias PT/EN, OpenAPI, Postman e frontend atualizados. Experimento de túnel IPv6 e scripts locais não incluídos.
- Atualize o destino antes de restaurar backups novos com números de sessão e autenticação diferentes. O alerta crítico da biblioteca mobile permanece sem correção conhecida.

## [Não lançado]

- Correção: evita estouro de pilha (recursão) ao tratar `editedMessage` e updates device-sent em `fromBaileysMessageContent` (desembrulha e remove `update` antes de recursão).
- Recurso: envios em grupo usam LID por padrão; pré-assert de sessões priorizando LIDs; fallback robusto para "No sessions" do libsignal e ack 421 com atrasos adaptativos e alternância de addressingMode.
- Recurso: em 1:1 o serviço aprende ativamente PN→LID (assertSessions + exists) e usa LID internamente quando disponível; logs detalhados do aprendizado.
- Recurso: cache PN↔LID nos stores de Arquivo e Redis com TTL; derivação de PN a partir de LID via normalização da Baileys quando ausente; persistência do mapeamento nos dois sentidos.
- Recurso: imagens de perfil usam PN canônico para nomes/chaves (FS e S3); gets/sets consideram as variantes PN e LID e registram logs de fallback.
- Docs: README e documentos de ambiente/arquitetura (PT-BR e EN) atualizados com o comportamento LID/PN, endereçamento em grupos, política PN-first nos webhooks e canonicidade das imagens.

## [4.0.2] - 2026-08-02

- Correção(Typebot): normaliza IDs de telefone e aliases numéricos sem adicionar `+` ao `phone_number_id`, preservando a compatibilidade com credenciais Meta-like.
- Correção(Typebot): normaliza erros e status de webhook para impedir respostas inválidas e repetição excessiva de falhas.
- Correção(contatos Zapo): resolve telefone para LID por `queriedJid`, usa cache local recente e limita a consulta à rede a um único lote por requisição.
- Correção(contatos Zapo): importação idempotente, substituição segura de LID obsoleto e retorno `503` em indisponibilidade transitória, sem marcar o contato como inválido.
- Correção(contatos Zapo): normalização brasileira centralizada e contagens separadas entre contatos canônicos, chaves brutas e chaves ignoradas.
- Interface: preserva modais durante atualizações automáticas e expõe os identificadores necessários às integrações.

## 3.0.0-beta-57

- Recurso(grupos): redução do fan-out de recibos/status no webhook/socket
  - Novas envs (padrão true): `GROUP_IGNORE_INDIVIDUAL_RECEIPTS`, `GROUP_ONLY_DELIVERED_STATUS`
  - Ignora `message-receipt.update` por participante em grupos; encaminha apenas `DELIVERY_ACK` via `messages.update` quando habilitado
  - Docs: seções adicionadas em EN/PT-BR e .env.example atualizado
- Correção(chamadas): webhook de rejeição agora retorna PN em vez de LID
  - Envia `key.senderPn` no evento notify sintético; o transformer prioriza PN para `contacts[0].wa_id` e `messages[0].from`
- Correção(decrypt): envia payload estruturado ao webhook em falhas de descriptografia (DecryptError)
  - Evita perdas silenciosas e ajuda o cliente a orientar o usuário (ex.: abrir WhatsApp no telefone)
- Correção(webhook): deduplicação leve de mensagens de entrada para evitar duplicatas em reconexão/importação de histórico
  - Nova `INBOUND_DEDUP_WINDOW_MS` (padrão 7000ms); ignora mesma combinação `remoteJid|id` vista na janela
- Tarefa: bump de versão para 3.0.0-beta-57

## 3.0.0-beta-58

- Correção(status 1:1): mapeia id do provedor para id UNO em `message-receipt.update` para correlacionar delivered/read corretamente
  - Garante que os updates de status no webhook usem o mesmo id retornado no envio; evita ficar “preso” em entregue ou perder o “lido” em 1:1
  - Normalização do id aplicada antes de emitir o webhook (ListenerBaileys)
- Tarefa: bump de versão para 3.0.0-beta-58

## 3.0.0-beta-59

- Correção(logging): evitar JSON.stringify em objetos WAProto (WAMessage) para prevenir erro `long.isZero`
  - Sanitiza logs no sender/listener para exibir jid/id/type em vez do objeto completo
  - Evita falsos negativos que causavam retry do job e envios duplicados
- Recurso(saída): idempotência para retries do job
  - Nova `OUTGOING_IDEMPOTENCY_ENABLED` (padrão true). Job consulta o store (key/status) pelo id UNO e ignora reenvio se já estiver processado
- Tarefa: bump de versão para 3.0.0-beta-59

## 3.0.0-beta-60

- Recurso(foto de perfil): padroniza nome de arquivo como número (PN) e suporta atualização do cache
  - Sempre salva como `<pn>.jpg` (ex.: `5511999999999.jpg`), mapeando LID→PN quando necessário
  - `PROFILE_PICTURE_FORCE_REFRESH` (padrão true) para atualizar o cache buscando no WhatsApp antes de retornar a URL
  - `getProfilePictureUrl` (S3/FS) resolve LID→PN e retorna URL nomeada pelo PN
- Correção(webhook): inclui foto de perfil também em updates/receipts usando cache local quando `sendProfilePicture` estiver ativo

## 3.0.0-beta-61

- Recurso(foto de perfil): prefetch ao enviar e logs detalhados
  - A cada envio (1:1/grupo) faz prefetch da foto para atualizar o cache do storage proativamente
  - Logs: início/fim do prefetch, lookup, cache hit, fetch no WA, URL local persistida, gravação FS/S3
- Correção(build): imports e acesso à config no listener
  - data_store_file: importa `ensurePn` e `PROFILE_PICTURE_FORCE_REFRESH`
  - listener_baileys: usa `config` em vez de `this.config`

## 3.0.0-beta-64

- Correção(foto 1:1): busca robusta de fotos de perfil
  - Tenta JID PN primeiro e depois LID mapeado (image → preview), sempre salvando como `<pn>.jpg`
  - Logs de prefetch/lookup/fetch/persist; valida existência no S3 antes de gerar URL
- Correção(logging): evita JSON.stringify de estruturas WAProto no envio (previne erro `long.isZero`)
- Miscelânea: pequenos ajustes de build e estabilidade

## 3.0.0-beta-52

- Recurso: adiciona provedor de transcrição de áudio Groq (endpoint compatível com OpenAI em `/audio/transcriptions`) com prioridade Groq → OpenAI → Whisper local (`audio2textjs`).
- Recurso: configuração por sessão para Groq, persistida no Redis e com prioridade sobre env:
  - `groqApiKey`, `groqApiTranscribeModel` (padrão `whisper-large-v3`), `groqApiBaseUrl` (padrão `https://api.groq.com/openai/v1`).
- Config: novas variáveis de ambiente integradas ao carregamento de config:
  - `GROQ_API_KEY`, `GROQ_API_TRANSCRIBE_MODEL`, `GROQ_API_BASE_URL`.
- UI: adicionados campos Groq no modal de configuração em `public/index.html` (`Groq API Key`, `Groq Transcribe Model`, `Groq API Base URL`) com i18n (EN/PT-BR).
- Docs: adicionados guias de transcrição `docs/TRANSCRIPTION_AUDIO.md` (EN) e `docs/pt-BR/TRANSCRICAO_AUDIO.md` (PT-BR); nova seção “Transcrição de Áudio” vinculada em `public/docs/index.html`.

---

## 3.0.0-beta-47

- Versão base mencionada pelos usuários; as correções e recursos acima entram como "Não lançado" até a próxima tag.

