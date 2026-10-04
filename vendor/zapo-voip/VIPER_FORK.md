# Plugin Zapo VoIP dedicado da ViperTec

This package is a vendored copy of `@zapo-js/voip`. It preserves the public
coordinator API and the upstream MIT license while allowing ViperConnect to
maintain the media fixes without following a complete Zapo repository fork.

## Runtime hibrido da ViperTec

- o fork nao e Zapo puro nem MeowCaller puro: offer e controles outbound ficam
  integrados ao plugin Zapo/ViperConnect; framing, relay direto, RTP/SRTP,
  codec e partes da maquina 1:1 usam os vetores do MeowCaller;
- o `Answer` inbound apenas confirma o estado local e abre o relay selecionado:
  nao envia `mute_v2` nem `transport` proativamente. O primeiro `mute_v2` do
  caller dispara `buildDirectAcceptStanza` com taxa de audio negociada,
  `net medium=2`, `encopt` e metadata, sem uma segunda `callKey`; depois do
  accept, o stanza recebido recebe ACK tipado com `type="mute_v2"`;
- o helper alternativo com `callKey` criptografada e `net medium=3` existe no
  fonte, mas nao e chamado por `WaCallMediaSession` e nao descreve o runtime;
- no outbound, o ACK do offer dispara o preaccept do caller; o preaccept remoto
  envia relaylatency e transport inicial 0/0; o accept remoto envia transport
  1/1 e `mute_v2(0)` ao device exato que atendeu;
- ignora offers ja encerrados e encerra corretamente em `reject` remoto ou ACK
  com erro;
- ordena os relays com FNA preferido no inbound e, no outbound, prioriza non-FNA
  com `auth_token_id`; abre somente o primeiro candidato selecionado e preserva
  os demais `te2` apenas para uma recuperacao elegivel;
- saida e recuperacao mantem somente um transporte logico por vez. Falha real
  de transporte/controle pode avancar o candidato. No inbound 1:1, o primeiro
  relay permanece selecionado enquanto o controle estiver vivo, inclusive sem
  o primeiro RTP ou durante stall de midia, pois nao existe reeleicao silenciosa
  pos-accept; apos 10 frames autenticados a midia e considerada estabelecida e
  o watchdog para para respeitar silencio/DTX;
- nao troca relay durante mute remoto ou `on_hold`; ao trocar preserva RTP,
  SRTP e codec e reaplica SSRCs, subscriptions e PIDs no proximo candidato;
- mantem `token_id` e `auth_token_id` independentes e aceita token binario ou
  textual;
- usa transporte direto UDP -> DTLS -> SCTP -> DataChannel negotiated id 0 pelo
  helper nativo em `native/relay-bridge`, sem ICE/PeerConnection;
- envia allocate e ping na abertura e a cada segundo, sem iniciar STUN Binding
  Requests;
- propaga `self_pid` e `peer_pid`, assina todos os SSRCs conhecidos e refaz a
  subscription quando o device aceito ou o SSRC real muda;
- preserva a identidade E2E-SRTP exata e tenta variantes autenticadas `:0`/bare
  somente na recepcao;
- seleciona o codec por chamada via `voip_settings`: o literal
  `use_mlow_codec_v1="false"` usa RFC Opus, `useSmpl: false` e rate `8000`;
  ausente, `"true"` ou malformado usa MLow, `useSmpl: true` e rate `16000`;
- negocia no `offer` inbound ou no ACK do `offer` outbound e ignora settings
  tardio depois do `preaccept`, evitando troca de codec durante a midia;
- encerra somente a perna inbound espelhada de chamada local quando o device que
  aceitou coincide com `meLid` ou `meJid`, sem enviar `terminate`;
- preserva a ordem wire dos filhos `te2`, sem ordenar os relays por RTT;
- registra a estrutura redigida das stanzas inbound e do accept direto para
  comparar Wi-Fi e rede movel: somente atributos de roteamento permitidos,
  nomes de atributos e tamanhos; nunca conteudo, token ou chave;
- correlaciona cada resposta outbound de `relaylatency` pelo stanza ID com ACKs
  e receipts inbound, e marca quando o relay consultado nao pertence ao
  conjunto autenticado do offer;
- preserva o ACK do `relaylatency` inbound, mas so devolve medicao para relays
  utilizaveis do offer (protocolo suportado, chave e token binario); relay sem
  credencial e registrado como `unauthenticated_relaylatency_skipped`;
- preserva candidatos IPv4 e IPv6 do offer em paralelo, usa sockets `udp4` e
  `udp6` explicitos e mantem a familia do relay WhatsApp independente da perna
  SIP/RTP; o A/B live de 2026-08-21 validou IPv6 em dados moveis e IPv4 no
  Wi-Fi sem erro SRTP/Opus;
- aceita RTP de audio PT 120 e 121 e mantem o marker para a primeira fala real,
  sem consumi-lo em DTX/priming.

O scaffold/fallback RFC Opus do MeowCaller ainda esta em progresso upstream. A
negociacao e os dois modos deste fork foram validados pelos testes locais e nao
devem ser descritos como uma capacidade ja concluida no MeowCaller.

Na revisao `6d9b7b2`, o MeowCaller observa settings em offer inbound, ACK
outbound e accept outbound, deixando o ultimo valor explicito valido vencer,
mas o loop continua MLow e a sinalizacao fixa em 16 kHz. Este fork usa
offer/ACK como pontos autoritativos e congela a escolha depois do
caller-preaccept.

A suite vendorizada possui testes unitarios para os contratos abaixo. Em
2026-08-05, oito chamadas reais com iPhone 16 e Galaxy S9e validaram entrada e
saida com audio bidirecional no primeiro relay. O failover forcado permanece
como canario separado porque nao foi acionado nessas chamadas.

Por padrão, o caminho ativo desabilita o fallback sintetico do normalizador e usa o endpoint
e a porta recebidos no `te2` selecionado; nao forca `3478` nem `3480`. O helper
de normalizacao preserva uma variante `3480` opcional para consumidores
explicitos, mas ela nao entra na selecao de midia 1:1 atual. Este pacote contem
somente a camada de chamada e midia. SIP, PBX, bridge, roteamento, gravacao e
interface permanecem no servico VoIP.

A opção `preferWebRelayPort` altera somente a porta de discagem para 3480,
sem trocar tokens, chaves, IPs ou identidade do relay. Na Uno ela está limitada
a dispositivos mobile-primary com `UNOAPI_MOBILE_PRIMARY_LAB=true` e servidor
`mobile_lab`. Sessões convencionais preservam a porta anunciada. O handshake
foi confirmado no laboratório; em 25/09/2026 o usuário também confirmou áudio
bidirecional em 4G e Wi-Fi. A VPS não foi alterada.

O mapeamento completo contra o Zapo oficial e o MeowCaller, incluindo diferencas
intencionais e o roteiro de validacao ao vivo, esta em
`docs/voip-meowcaller-audit.md` na raiz do ViperConnect.

Upstream: <https://github.com/vinikjkkj/zapo>
