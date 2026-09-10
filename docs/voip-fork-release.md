# Plugin VoIP dedicado mantido pela ViperTec

A UnoAPI usa o pacote `@vipertec/zapo-voip`, mantido diretamente em
`vendor/zapo-voip` dentro do ViperConnect. Ele nao depende de acompanhar um fork
completo do repositorio Zapo.

Versão atualmente integrada: `1.0.0-viper.6`.

O pacote e incorporado ao build por `file:vendor/zapo-voip`. A pasta contem o
codigo-fonte auditavel e o `dist` usado em producao, tornando a imagem
reproduzivel sem depender do registry npm durante o build.

O runtime e explicitamente **hibrido**. A oferta, parte dos controles de chamada
e a integracao com o `WaClient` continuam no plugin Zapo/ViperConnect. O
transporte direto, o framing de relay e partes da maquina 1:1 seguem os vetores
do MeowCaller. Isso nao deve ser descrito como Zapo puro nem como uma copia
integral do MeowCaller.

A separacao completa dos dois processos, dos dois `package.json`, do bridge PCM
e da solucao final de midia esta em `docs/voip-zapo-runtime.md`.

Principais ajustes locais:

- descoberta explicita dos dispositivos do destinatario antes da oferta;
- DataChannel WASM pre-negociado com label `pre-negotiated` e id `0`;
- transporte de relay direto `UDP -> DTLS client -> SCTP client -> DataChannel`,
  sem ICE, SDP ou `RTCPeerConnection`; o helper Go estatico fica dentro da mesma
  imagem e e iniciado por chamada pelo worker Zapo;
- Allocate STUN com token, endpoint e os nove stream descriptors `0x4024`
  derivados de `call-id + LID` nos slots `[0,1,4,2,3,5,7,8,6]`;
- consent ping `0x0801` enviado depois do Allocate e renovacao conjunta durante
  o keepalive;
- resposta `Binding Success` autenticada para cada `Binding Request` de consent
  enviado pelo relay;
- framing RTP/WARP com perfil `0xDEBE` e palavra DTX `0x30010000` somente nos
  frames de comfort-noise;
- sequencia RTP inicial `1` e timestamp inicial `0`, conforme os vetores do
  MeowCaller;
- oferta usando `enc` inline para um unico dispositivo e
  `destination > to[jid] > enc` somente para multiplos dispositivos, conforme
  o envelope validado pelo MeowCaller;
- aceite direto de chamada recebida adiado ate o primeiro `mute_v2` do caller;
  o envelope ativo usa `audio` na taxa negociada, `net medium="2"`, `encopt` e
  metadata, sem transportar uma segunda `callKey` no `accept`;
- o `Answer` inbound apenas confirma o estado local e abre o relay selecionado,
  sem enviar `mute_v2` ou `transport` proativamente; depois do primeiro
  `mute_v2`, o accept direto precede o ACK de classe `call` tipado como
  `type="mute_v2"`;
- na saida, o ACK do offer dispara o `preaccept` do caller; o `preaccept`
  recebido gera `relaylatency` para os relays anunciados e um `transport`
  inicial (`transport-message-type="0"`, `p2p-cand-round="0"`); depois do
  `accept`, o plugin envia `transport` 1/1 e `mute_v2(0)` ao device que atendeu;
- selecao de codec isolada por chamada a partir de `voip_settings`: o literal
  `encode.use_mlow_codec_v1="false"` usa RFC Opus com `useSmpl: false` e
  sinaliza `audio rate="8000"`; configuracao ausente, `"true"` ou malformada
  mantem MLow com `useSmpl: true` e `audio rate="16000"`;
- negociacao lida no `offer` da chamada recebida e no ACK do `offer` da chamada
  de saida; depois do envio do `preaccept`, qualquer `voip_settings` tardio e
  ignorado para nao trocar codec e taxa no meio da chamada;
- aceite de saida nao envia `accepted_elsewhere` por conta propria; em especial,
  o participante device zero pode aparecer como `user@lid` no ACK e
  `user:0@lid` no aceite, sendo o mesmo aparelho;
- a perna recebida espelhada de uma chamada entre duas sessoes locais e encerrada
  somente no estado interno quando o aparelho que aceitou coincide com o
  `meLid` ou o `meJid` da sessao; esse guard nao envia `terminate` ao WhatsApp;
- roteamento do ACK de oferta pelo `call-id` do filho `relay`, inclusive depois
  de a chamada entrar em estado ativo;
- preservacao da ordem original dos filhos `te2` recebidos no wire, sem ordenar
  por RTT antes da escolha do relay;
- selecao logica FNA para entrada e nao-FNA autenticado para saida, com
  preservacao dos candidatos IPv4 e IPv6 anunciados para o mesmo relay;
- recuperacao sequencial local dos demais relays anunciados, sempre com um
  unico candidato logico ativo. O outbound pode avancar por falta de
  transporte/controle, primeiro Opus ou stall; o inbound retém o primeiro relay
  enquanto o controle estiver vivo e so avanca por falha real desse
  transporte/controle. Dez frames autenticados encerram o watchdog para que
  silencio/DTX nao provoque troca indevida;
- troca de relay preservando RTP/SRTP/codec, reaplicando SSRCs, subscriptions e
  PIDs, sem alterar porta anunciada nem codec negociado e sem trocar durante
  mute remoto ou `on_hold`;
- testes do envelope da oferta, sequencia do aceite, descritores WASM e
  configuracao de relay.

Na revisao MeowCaller `6d9b7b2`, o settings e observado no offer inbound, no ACK
outbound e no accept outbound, vencendo o ultimo valor explicito valido. Isso e
apenas scaffold: o loop de midia continua MLow e a sinalizacao permanece fixa em
16 kHz. A integracao ViperConnect usa deliberadamente apenas offer/ACK e congela
a decisao depois do caller-preaccept.

O relay ativo usa exatamente a porta anunciada no ACK (normalmente `3478`). A
selecao 1:1 chama o normalizador com o fallback sintetico desabilitado, portanto
nao cria uma variante `3480`. No inbound, os endpoints IPv4 e IPv6 realmente
anunciados podem ser preconectados em paralelo ate a midia SRTP autenticada
confirmar o caminho; no outbound a recuperacao continua sequencial. Enderecos
`te2` de 6 bytes usam `udp4` e os de 18 bytes usam `udp6`, sempre com bind
explicito da mesma familia. O helper exportado ainda preserva a variante 3480
opcional para consumidores explicitos.
No atributo WASM `0x0016`, o endereco IPv6 aplica o magic cookie e depois o
transaction ID em tres palavras `uint32` little-endian. O caminho IPv4 nao foi
alterado. A quarentena de um eventual `452` permanece limitada ao candidato
IPv6 rejeitado.
O build multi-stage compila
`vendor/zapo-voip/native/relay-bridge/relay-bridge`; em instalacao nativa, o
caminho pode ser informado por `ZAPO_VOIP_RELAY_BRIDGE_PATH`.

O suporte IPv6 do relay WhatsApp nao muda a familia do ramal SIP. O worker
termina a perna DTLS/SCTP do WhatsApp e entrega PCM pelo WebSocket interno
existente; o servico VoIP pode manter RTP/SIP IPv4 para o ramal. Nao ha NAT64
de pacotes. Em 2026-08-21, uma entrada por dados moveis confirmou RTP remoto
pelo IPv6 de `bsb1c01`; uma entrada Wi-Fi de regressao confirmou RTP pelo IPv4
de `gru2c01`. Ambas tiveram audio bidirecional e zero erro SRTP/Opus. Essa
validacao ocorreu no hostpatch 09 e foi incorporada à imagem unificada
`v4.0.29`.

## Estado de verificacao e deploy

- `210/210` testes do plugin vendorizado passaram no runtime usado para a
  verificacao local;
- os builds CommonJS e ESM incluem a negociacao de codec e o guard da perna
  local espelhada;
- o hostpatch `hostpatch-zapo-relay-authenticated-latency-20260820-09` foi
  aplicado somente ao worker Zapo sobre a imagem `4.0.20`. Ele preserva o ACK
  de `relaylatency`, ignora somente probes sem credencial no offer e foi
  validado em dados moveis/IPv6 e Wi-Fi/IPv4; o rollback e a revisao 08;
- o hostpath `zapo-voip-relay-recovery-20260805-02` foi aplicado sobre a imagem
  `4.0.7`, e somente o container do worker Zapo foi recriado;
- o roteamento sem slots foi validado com o hostpath
  `slotless-routing-20260806-03` no processo VoIP. O bundle usa capacidade por
  linha e nao contem `no_available_voip_slot`, `outbound_slot`, `account.slots`
  nem `deviceSlotIds` no JavaScript ativo;
- o hostpath `zapo-incoming-reject-20260806-01` foi aplicado somente ao worker
  Zapo. Ele ignora `<reject>` numa chamada inbound sem alterar arquivos de
  midia; o CommonJS ativo foi conferido nos dois caminhos com SHA-256
  `f49be3653f094e78de8b8a71f9d56934060c080be09f310d6e042c0ed2f7d511`;
- o hostpatch `pcm-frame-20260828-01` foi aplicado somente ao worker Zapo sobre
  `4.0.29`. Cinco chamadas bidirecionais confirmaram a normalização por blocos
  de 960; o caso antes problemático produziu 787 quadros, todos recebidos pelo
  bridge, com zero erro SRTP, Opus ou PCM. O código integra a versão
  `1.0.0-viper.6` e a imagem unificada `v4.0.30`;
- em 2026-08-05 foram validadas oito chamadas bidirecionais: duas entradas e
  duas saidas SIP com iPhone 16, seguidas pela mesma matriz com Galaxy S9e;
- todas estabilizaram no primeiro relay, com contadores remotos autenticados
  positivos e sem erro SRTP ou Opus;
- em 2026-08-06, duas chamadas de saida simultaneas e duas chamadas de entrada
  simultaneas foram validadas na mesma linha. As sobreposicoes ativas foram de
  5,659 s e 10,927 s, respectivamente; todas tiveram audio bidirecional, fim
  normal e zero erro SRTP/Opus;
- no mesmo canario, uma entrada real na linha `5566996222471` comprovou o guard
  de rejeicao: tocou os ramais, atendeu, manteve audio nos dois sentidos e
  encerrou normalmente;
- antes do commit, o mesmo estado foi revalidado em mais quatro chamadas. Os
  call IDs `00BA672F9419331B09FF04EB85A88531`,
  `00B17BF9607D128100B831F70288C3E7`,
  `93A38685363FB784FD20A3A7460A4203` e
  `002709E2597F798D574F45B50D605BB7` fecharam com `recvOk`/`opusOk` de 91, 83,
  50 e 44, respectivamente, e zero erro SRTP;
- os SHA-256 do CommonJS aplicado e revalidado sao
  `87d0011588c10451ef68301a22128264a327ac2e8aab8641a5834be35d6c61d8`
  (`WaCallMediaSession.js`),
  `f49be3653f094e78de8b8a71f9d56934060c080be09f310d6e042c0ed2f7d511`
  (`WaCallManager.js`) e
  `d99a6e28ab14975f15dc1fa682a45ceb868d9a5fc124fde81172c883d720f9cb`
  (`signaling/bridge.js`);
- a telefonia nao precisou ser reiniciada porque a alteracao validada pertence
  ao vendor executado pelo worker. Ela continua usando o pacote incorporado na
  imagem ate a proxima publicacao unificada.

Essa verificacao prova o caminho normal com relay vivo em dois modelos de
aparelho, a capacidade concorrente padrao e o guard de rejeicao inbound. O
failover sequencial esta coberto pela suite, mas ainda precisa de um canario que
degrade deliberadamente o primeiro relay.

Os hostpaths acima sao canarios temporarios: recriar os containers apenas com o
Compose base os remove. A promocao termina somente quando a imagem unificada
incorporar os SHAs exatos dos dois repositorios, passar os guards de build e
rodar sem mounts sobre `dist`.
