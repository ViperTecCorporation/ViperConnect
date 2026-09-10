# @vipertec/zapo-voip

## 1.0.0-viper.6

- Normaliza o PCM decodificado por chamada antes do bridge: quadros maiores
  são divididos, fragmentos menores são acumulados e somente blocos ordenados
  de 960 amostras são entregues.
- Remove o preenchimento artificial de fragmentos curtos e preserva restos até
  o próximo decode, descartando apenas a sobra incompleta no encerramento.
- Separa falhas de entrega PCM de falhas de autenticação SRTP e acrescenta
  `pcmDeliveredFrames`, `pcmDeliveryErrors` e `pcmPendingSamples` ao resumo da
  chamada.
- Adiciona regressão para 320+640, 960, 1200+720 e 1920 amostras, além da
  validação integrada de entrega e classificação de erros.

## 1.0.0-viper.5

- Valida o contrato vendorizado de sinalização, relay, mídia, IPv4/IPv6 e
  compatibilidade MeowCaller com `zapo-js` 1.8.x.
- Restringe a peer dependency para a linha Zapo efetivamente validada.

## 1.0.0-viper.4

### ViperConnect fixes

- Documenta e estabiliza o runtime hibrido, sem apresenta-lo como Zapo puro ou
  MeowCaller puro.
- Mantem o accept inbound direto depois do primeiro `mute_v2`, com taxa de audio
  negociada, `net medium=2`, `encopt` e metadata, sem uma segunda `callKey` no
  accept.
- Congela o `Answer` inbound sem controles proativos: ele apenas confirma o
  estado local e abre o relay. O primeiro `mute_v2` do caller dispara o accept
  direto e recebe em seguida um ACK de classe `call` tipado como `mute_v2`.
- Mantem o primeiro relay inbound enquanto o plano de controle estiver vivo;
  zero RTP inicial ou stall de midia nao provocam reeleicao silenciosa depois do
  accept.
- Mantem preaccept do caller apos o ACK do offer, relaylatency e transport
  inicial no preaccept remoto, alem de transport 1/1 e `mute_v2(0)` depois do
  accept remoto.
- Deriva a chave SRTP de recepcao do `callKey` do peer quando o accept traz uma
  chave diferente da usada pelo caller.
- Seleciona o codec por chamada via `voip_settings`: o literal
  `use_mlow_codec_v1="false"` usa RFC Opus (`useSmpl: false`, rate `8000`),
  enquanto ausente, `"true"` ou malformado mantem MLow (`useSmpl: true`, rate
  `16000`). A negociacao ocorre no offer inbound ou no ACK do offer outbound e
  settings tardio e ignorado depois do `preaccept`.
- Diferencia essa negociacao do scaffold MeowCaller `6d9b7b2`, que observa
  offer/ACK/accept e deixa o ultimo valor valido vencer, mas ainda executa MLow
  com sinalizacao fixa em 16 kHz.
- Protege chamadas entre sessoes locais encerrando apenas a perna inbound
  espelhada quando o device aceito coincide com `meLid` ou `meJid`, sem enviar
  `terminate` ao WhatsApp.
- Preserva a ordem wire dos filhos `te2` em vez de ordenar candidatos por RTT.
- Recupera a midia inicial sequencialmente pelos demais relays reais do `te2`,
  mantendo apenas um candidato logico ativo, preservando RTP/SRTP/codec e
  usando somente frames Opus autenticados para decidir a troca.
- Registra que o fallback RFC Opus permanece em progresso no MeowCaller; a
  integracao deste fork foi validada por testes proprios.
- Adiciona testes de envelope, ordem, criptografia, codec e sinalizacao nos dois
  sentidos; `176/176` testes do plugin passam.

### Estado do deploy de validacao

- O hostpath foi aplicado sobre a imagem `4.0.7` e somente o worker Zapo foi
  recriado.
- Oito chamadas reais em 2026-08-05 (entrada e saida, iPhone 16 e Galaxy S9e)
  tiveram audio bidirecional, sem erro SRTP ou Opus.
- Todas estabilizaram no primeiro relay. A recuperacao sequencial esta coberta
  pela suite, mas o failover forcado ao vivo continua pendente.
- O artefato congelado foi revalidado em mais quatro chamadas reais, todas com
  audio bidirecional, `recvOk`/`opusOk` positivos e zero erro SRTP. Os hashes
  SHA-256 do CommonJS validado sao `87d001...c61d8` (media session),
  `055269...aec28` (manager) e `d99a6e...f9cb` (bridge).
- O servico SIP/VoIP nao precisou ser reiniciado; ele continua usando o pacote
  incorporado na imagem ate a proxima publicacao unificada.

## 1.0.0-viper.3

### ViperConnect fixes

- Troca o transporte baseado em PeerConnection pelo helper nativo direto
  UDP/DTLS/SCTP/DataChannel, compilado na imagem do ViperConnect.
- Alinha selecao de relay, allocate, keepalive, subscriptions e identidade de
  participante com o fluxo direto validado por vetores do MeowCaller.
- Corrige devices exatos na sinalizacao, encerramento por reject/ACK com erro e
  offers recebidos ja encerrados.
- Corrige recepcao E2E-SRTP com variantes autenticadas de device, PT 120/121 e
  marker RTP preservado durante DTX/priming.
- Adiciona vetores e testes do helper nativo, STUN, SRTP, SSRC, RTP e uma captura
  MLow real. A validacao com relay vivo continua sendo uma etapa de release.

## 1.0.0

### Major Changes

- Initial release: WhatsApp VOIP (calling) plugin for `zapo-js`. Registers on
  `WaClient` via `voipPlugin()` and exposes the calling API at `client.voip`.
- MLow voice codec through `libmlow-wasm` (WASM, no native build step or bundled
  binaries).
- Full media stack: `<call>` signaling, RTP/SRTP, STUN, WebRTC/SCTP relay
  transport, and audio engine.
- Pre-recorded outbound audio (`loadAudio`) and live 16 kHz mono PCM
  (`feedLiveAudio`).
- Multi-call support with per-call `CallMediaSession` instances and
  `maxConcurrentCalls` (default `1`). Extra incoming offers wait with
  `canAccept: false` until a slot frees.
- Incoming `<call>`, call-class `<ack>`, and call `<receipt>` handlers are
  registered automatically (prepend, no double-ack).
- Requires `zapo-js@^1.0.0` and `libmlow-wasm`. ViperConnect compiles the native
  DTLS/SCTP relay helper from `native/relay-bridge`; `fluent-ffmpeg` remains optional
  for file decode in `loadAudio`.
