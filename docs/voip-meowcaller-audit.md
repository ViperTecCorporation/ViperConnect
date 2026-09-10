# Auditoria do VoIP Zapo e do transporte Meow Caller

## Escopo e revisão analisada

Esta auditoria compara o plugin incorporado em `vendor/zapo-voip` com o fluxo de
chamada direta do Meow Caller. A referência foi fixada no `origin/main`:

- commit: `6d9b7b2c18072155a4581ab8c7fccc51b4fd0a73`;
- data: `2026-07-26T20:02:03+02:00`;
- título: `Add upstream-compatible group calls and call controls (#18)`.

A visão operacional dos dois processos, de seus arquivos `package.json` e da
ponte PCM está consolidada em `docs/voip-zapo-runtime.md`.

O `fetch` confirmou que esse commit ainda era o topo remoto em 2026-08-04.

Foram inventariados os 226 arquivos da revisão: 199 arquivos textuais, 101.505
linhas analisáveis, 147 fontes Go e 338 testes Go. Os 27 arquivos não textuais são
vetores, seeds, capturas e amostras de áudio. A leitura aprofundada concentrou-se no
caminho de chamada direta; os demais domínios foram classificados para separar
dependências do áudio 1:1 de funcionalidades futuras.

O código atual é deliberadamente **híbrido**. O Meow Caller é a referência para o
transporte relay direto, framing, RTP/SRTP, SSRC, codec e partes do fluxo 1:1. O
plugin Zapo/ViperConnect continua fornecendo a integração com o cliente, o offer
criptografado e os controles usados pela chamada de saída. Não existe, no runtime
atual, uma reversão integral para a sinalização Zapo: o inbound ainda usa o
`buildDirectAcceptStanza` derivado do Meow Caller.

O helper `buildAcceptStanza`, com `callKey` criptografada e `net medium="3"`,
permanece no código-fonte, mas não é chamado por `WaCallMediaSession`. Portanto,
ele não descreve o envelope executado nos testes nem na implantação atual.

| Domínio | Arquivos | Papel na comparação |
| --- | ---: | --- |
| raiz | 50 | ciclo da chamada, mídia, codec, playout e API |
| `signaling` | 14 | envelopes de offer, preaccept, accept, relay e controles |
| `relay` | 5 | UDP, DTLS, SCTP e DataChannel |
| `stun` | 4 | allocate, ping/pong, consent e subscriptions |
| `rtp` | 11 | RTP, RTCP, SSRC, vídeo e vetores de fio |
| `srtp` | 10 | E2E-SRTP, SRTCP, WARP, HBH e SFrame |
| `mlow` | 75 | codec, tabelas, vetores e capturas |
| audio/util | 8 | PCM, fontes, sinks, HKDF e participante |
| grupos e app-data | incluídos acima | SFU, rekey, mixer, reações e call links |
| exemplos, diagnóstico e docs | 48 | integração, captura e interfaces de teste |

## Mapa do caminho de áudio 1:1

```text
SIP 8 kHz
  -> bridge VoIP (20 ms x 3, resample para 16 kHz)
  -> WebSocket voip_to_uno (Float32, 960 amostras)
  -> codec negociado por chamada: MLow ou RFC Opus (60 ms)
  -> RTP + E2E-SRTP/WARP
  -> DataChannel id 0, label pre-negotiated
  -> SCTP cliente -> DTLS cliente -> UDP -> relay Zapo

relay Zapo
  -> UDP -> DTLS -> SCTP -> DataChannel
  -> E2E-SRTP/WARP -> MLow ou RFC Opus -> PCM 16 kHz
  -> WebSocket uno_to_voip
  -> bridge VoIP (resample para 8 kHz, pacotes SIP de 20 ms)
```

O contrato PCM/WebSocket/SIP está coerente nos dois sentidos. No incidente anterior,
o contador `rtpRecv=0` comprovou que o áudio remoto ainda não havia chegado ao
decodificador nem à ponte SIP; portanto, o sintoma estava antes dessa camada.

## Matriz de compatibilidade

| Camada | Meow Caller | ViperConnect após auditoria | Estado |
| --- | --- | --- | --- |
| resolução do destino | converte PN para LID antes do offer | converte com `queryLidsByPhoneJids` e usa o LID resolvido | alinhado |
| offer | ordem `privacy, audio 8k, audio 16k, net, capability, enc/destination, encopt, identity` | mesma ordem e inline `enc` para um device | alinhado e testado |
| offer já encerrado | ignora `is_call_ended=1` ou `terminate_reason` | agora ignora antes de decrypt/preaccept | corrigido |
| preaccept recebido | apenas muda estado do caller | envia `relaylatency` por relay e um `transport` inicial 0/0 uma vez | híbrido e testado |
| preaccept enviado | somente pelo callee | caller envia depois do ACK do offer; callee envia no offer inbound | adaptação ViperConnect testada |
| Answer inbound | aguarda a sinalização do caller | confirma o estado local e abre o relay, sem enviar `mute_v2` ou `transport` proativamente | alinhado ao pacote capturado e validado |
| accept do callee | forma direta após `mute_v2` | o primeiro `mute_v2` dispara `buildDirectAcceptStanza`, taxa negociada, `net medium=2`, `encopt` e metadados, sem segunda `callKey` | derivado do Meow Caller e testado |
| ACK do `mute_v2` inbound | ACK após tratar o controle | envia o accept direto primeiro e depois ACK de classe `call` tipado com `type="mute_v2"` | alinhado ao pacote capturado e validado |
| destino do signaling | varia por tipo de stanza | accept usa o peer recebido; transport/mute pós-accept preservam o device que atendeu | híbrido e testado |
| reject remoto | encerra imediatamente | agora encerra, emite estado e remove a chamada | corrigido |
| ACK com erro | falha e encerra a chamada | agora encerra e libera o slot | corrigido |
| relaylatency | encaminha medidas dos relays | outbound envia um stanza por relay no preaccept; inbound preserva o ACK e só responde probes respaldados por protocolo, chave e token do offer | adaptação ViperConnect testada ao vivo |
| ordem de `te2` | consome os candidatos na ordem recebida | parser preserva a ordem wire e não reordena por RTT | alinhado e testado |
| escolha do relay | inbound prefere FNA; outbound prefere non-FNA com `auth_token_id`; usa um relay | mesma seleção e somente um relay | alinhado e testado |
| recuperação de relay 1:1 | não implementa failover depois que o transporte abre | extensão local: preserva os `te2` e configura um por vez; outbound pode avançar por ausência de transporte/controle, ausência do primeiro Opus autenticado ou stall; inbound retém o primeiro relay enquanto o controle estiver vivo, mesmo sem RTP ou durante stall, e só avança por falha real de transporte/controle; após 10 frames autenticados, encerra definitivamente o watchdog; suspende em mute/on-hold e preserva RTP/SRTP/codec | extensão local testada |
| ids de token | `token_id` e `auth_token_id` são independentes | parser não confunde mais os dois; aceita token binário ou string | corrigido |
| transporte FNA/non-FNA | ambos usam UDP -> DTLS -> SCTP -> DataChannel | ambos usam o helper nativo; removido UDP cru do FNA | corrigido |
| família do relay | referência analisada usa o endpoint anunciado | preserva endpoints IPv4 e IPv6 paralelos, abre `udp4`/`udp6` explícitos e rejeita família incompatível | extensão dual-stack testada ao vivo |
| pilha Pion | datachannel 1.6.0, dtls 3.1.2, logging 0.2.4, sctp 1.9.4 | mesmas bibliotecas e versões | alinhado |
| DataChannel | negotiated, id 0, label `pre-negotiated` | mesmo contrato | alinhado e testado |
| allocate | token `0x4000`, 9 streams `0x4024`, endpoint `0x0016`, MI, sem fingerprint | mesmo KAT byte a byte | alinhado e testado |
| consent | allocate + ping imediato; repete ambos a cada 1 s; não envia Binding Request | mesma sequência; responde Binding Request originado pelo relay | alinhado e testado |
| SSRC | HKDF e slots `[0,1,4,2,3,5,7,8,6]` | mesmo KAT; auxiliares 6..8 únicos e aleatórios | alinhado e testado |
| identidade SRTP | device exato e variantes `:0`/bare na recepção | mesma formatação e fallback autenticado; fixa a variante após sucesso | corrigido e testado |
| SRTP | AES-CTR, HKDF por participante, MI WARP de 4 bytes | mesmos vetores, replay window e ROC | alinhado e testado |
| RTP inicial | seq 1, timestamp 0; marker apenas na primeira fala real | DTX/priming não consomem mais o marker | corrigido e testado |
| payload type | áudio aceita PT 120 e PT 121 | agora aceita ambos | corrigido e testado |
| RTP/RTCP | classifica RTCP antes de RTP | RTCP não é mais contado como RTP nos diagnósticos | corrigido |
| codec por chamada | possui scaffold de `voip_settings`, mas o fallback RFC Opus ainda está em progresso upstream | `false` seleciona RFC Opus; ausente, `true` ou malformado mantém MLow | integrado e testado |
| MLow | 16 kHz, 960 amostras, 60 ms | `libmlow-wasm` com `useSmpl: true` e sinalização 16 kHz | alinhado |
| RFC Opus | sinalizado por `use_mlow_codec_v1=false`; suporte completo ainda não deve ser atribuído ao upstream | `libmlow-wasm` com `useSmpl: false` e sinalização 8 kHz | integrado e testado |
| captura MLow | possui `inbound_capture_frames.json` | frame real da captura decodifica 960 amostras, sem erro e com sinal não nulo | validado por teste |
| PCM/SIP | sink recebe frames decodificados | evento remoto vai para `uno_to_voip`; o sentido SIP usa `voip_to_uno` | alinhado |
| perna local espelhada | não se aplica ao processo com uma única conta | compara o device que aceitou com `meLid` e `meJid`, encerra apenas a perna inbound local e não envia `terminate` | corrigido e testado |
| estado active | somente após primeiro RTP remoto autenticado | ainda fica active quando o relay abre | diferença intencional por enquanto |
| SRTCP | SR+SDES a cada 1,5 s e recepção autenticada | sender reports de áudio implementados e cobertos por vetor | alinhado para áudio |
| jitter/playout | buffer por timestamp e relatórios de recepção | buffer simples no plugin; o bridge SIP tem sua própria cadência | melhoria futura, não causa `rtpRecv=0` |
| vídeo | H.264/PT97, WARP, SRTCP e PLI, marcado upstream como não validado ao vivo | sinalização antiga VP8, sem caminho de mídia | não suportado |
| grupo/call link/app-data | implementação extensa, várias partes ainda `partial`/não validadas | fora do plugin de áudio 1:1 | fora do escopo atual |

## Estado confirmado da sinalização

O commit `5dd78e15` trocou o transporte baseado em PeerConnection pelo helper
nativo. O estado atual preserva esse transporte e também preserva o accept
direto. No inbound, o `Answer` apenas confirma o estado local e abre o primeiro
relay selecionado; ele não envia `mute_v2` nem `transport` proativamente. A
sessão aguarda o primeiro `mute_v2` do caller, envia
`buildDirectAcceptStanza` com `net medium="2"`, sem uma segunda `callKey`
criptografada, e somente depois responde ao stanza recebido com ACK de classe
`call` tipado como `type="mute_v2"`.

O primeiro relay inbound permanece selecionado enquanto seu plano de controle
estiver vivo. Zero RTP inicial ou stall de mídia não autorizam uma troca
silenciosa pós-accept; somente uma falha real do transporte ou do controle torna
o próximo candidato elegível.

Na chamada de saída, o fluxo ativo é diferente: o ACK do offer permite negociar
o codec e envia o preaccept do caller; o preaccept remoto provoca relaylatency e
transport inicial; o accept remoto inicializa a mídia e envia transport 1/1 mais
`mute_v2(0)` ao device que atendeu. Esse conjunto é híbrido e precisa ser
avaliado como uma unidade. Um teste dele não prova falha do Zapo puro nem do
Meow Caller puro.

## Motivo para manter o helper nativo

O transporte anterior criava um `RTCPeerConnection`, portanto emitia STUN Binding
Requests. O próprio Meow Caller documenta que esse comportamento troca o relay para o
modo de consentimento ICE e impede a ponte de mídia esperada pelo fluxo Web. Isso bate
com a evidência observada: o telefone recebia o RTP enviado pela Uno, havia allocate e
pong, mas o relay nunca entregava RTP remoto (`rtpRecv=0`).

O helper nativo remove ICE por completo e replica a pilha direta do Meow Caller. O
allocate e os pongs ao relay já foram comprovados em chamadas reais; ele continua no
código. Os controles adicionais descritos acima pertencem ao fluxo híbrido atual e
não transformam o transporte em uma execução Zapo pura.

O próprio Meow Caller marca `ConnectRelayMedia`, `Send` e `Recv` como `NOT VALIDATED`
por não possuir vetor para um relay vivo. Seus componentes de fio possuem KATs; o salto
ao vivo também precisa ser validado no nosso ambiente.

## Negociação de codec por chamada

Na revisão Meow Caller `6d9b7b2`, o `voip_settings` é observado em três pontos:
offer inbound, ACK outbound e accept outbound; o último valor explícito válido
vence. Esse comportamento ainda é um scaffold: o loop de mídia continua
instanciando MLow e a sinalização permanece fixa em `audio rate="16000"`.

Na integração ViperConnect, o `voip_settings` autoritativo é lido em dois pontos:
no `offer` de uma chamada inbound e no ACK do `offer` de uma chamada outbound.
Somente o valor literal
`encode.use_mlow_codec_v1="false"` seleciona RFC Opus, desativa SMPL
(`useSmpl: false`) e usa `audio rate="8000"` no `preaccept` e no aceite direto.
Configuração ausente, `"true"` ou malformada usa o fallback seguro MLow, ativa
`useSmpl: true` e sinaliza `audio rate="16000"`.

A decisão fica congelada quando o `preaccept` é enviado. Um ACK repetido ou outro
settings tardio, inclusive no accept outbound, não pode reinicializar o codec
durante a mídia. A integração local dos dois modos, a inicialização antes do
`preaccept` e as taxas anunciadas são cobertas por testes. Isso não significa que
o fallback RFC Opus esteja concluído no Meow Caller.

Para chamadas entre duas sessões hospedadas no mesmo worker, o mesmo `call-id` pode
aparecer também como uma perna inbound espelhada. O guard compara a base do device que
aceitou com as bases de `meLid` e `meJid`; quando coincide, encerra e limpa apenas essa
perna local, sem transmitir `terminate` ao WhatsApp e sem interferir na perna outbound.

## Alterações que não devem ser feitas por tentativa

- Não voltar a abrir ICE/PeerConnection nem enviar Binding Requests proativamente.
- Não forçar porta 3478 ou 3480 no caminho ativo: usar a porta do `te2`
  selecionado e manter desabilitado o fallback sintético do normalizador.
- Não ordenar os filhos `te2` por RTT: preservar a ordem em que vieram no wire.
- Não abrir todos os relays anunciados: selecionar somente um pela regra FNA/direção.
- Não enviar `mute_v2` ou `transport` proativamente no `Answer` inbound: aguardar
  o primeiro `mute_v2`, enviar o accept direto e depois o ACK tipado
  `type="mute_v2"`.
- Não trocar o primeiro relay inbound enquanto seu controle estiver vivo, mesmo
  que o primeiro RTP ainda não tenha chegado ou a mídia esteja em stall.
- Não inventar `:0` para transport/mute/terminate: usar o device observado no
  fluxo. O accept direto atual não deve ser documentado como accept oficial.
- Não trocar `buildDirectAcceptStanza` pelo helper Zapo não utilizado sem um A/B
  controlado: o runtime atual espera `mute_v2`, usa `medium=2` e não envia uma
  segunda `callKey` no accept.
- Não remover o preaccept do caller, relaylatency, transport inicial nem
  transport/mute pós-accept: todos estão ativos no outbound atual.
- Não marcar SRTCP como causa do `rtpRecv=0`; os reports são importantes para vídeo e
  qualidade/continuidade, mas acontecem depois de o relay já estar entregando pacotes.
- Não atrasar o estado usado pela ponte SIP até o primeiro RTP remoto sem redesenhar o
  handshake: o RTP local antecipado ajuda o relay a aprender o SSRC e evita deadlock.
- Não renegociar codec depois do `preaccept`; settings tardio deve ser ignorado.
- Não apresentar o fallback RFC Opus como concluído no Meow Caller. O scaffold está em
  progresso upstream; a seleção e os dois modos descritos aqui pertencem à integração
  local validada por testes.

## Validação ao vivo concluída

Em 2026-08-05, foram executadas oito chamadas com áudio bidirecional:

| Aparelho | Direção | Quantidade | Resultado |
| --- | --- | ---: | --- |
| iPhone 16 | entrada | 2 | bidirecional |
| iPhone 16 | saída pelo SIP | 2 | bidirecional |
| Galaxy S9e | entrada | 2 | bidirecional |
| Galaxy S9e | saída pelo SIP | 2 | bidirecional |

Os contadores remotos autenticados foram `117`, `39`, `51`, `86`, `171`, `89`,
`66` e `40`, com `srtpErrors=0`, `opusErr=0` e tráfego positivo na ponte SIP
nos dois sentidos. Todas as chamadas estabilizaram no primeiro relay. Isso
valida ao vivo o caminho normal, mas não demonstra que o failover foi acionado.

Um canário com o primeiro relay deliberadamente degradado continua como
critério separado. A concorrência foi validada em 2026-08-06 com duas entradas
simultâneas e duas saídas simultâneas na mesma linha, todas com áudio
bidirecional e sem erro SRTP/Opus; os call IDs e tempos de sobreposição estão
registrados em `docs/voip-zapo-runtime.md`.

Em 2026-08-21, um A/B adicional isolou a falha intermitente de entrada por
dados móveis. O aparelho media `fcgb9c01` como o relay mais rápido, embora esse
nome não tivesse token/chave no offer. Responder a esse probe permitia que o
peer mantivesse um caminho que o worker não podia autenticar. A revisão 09
preservou o ACK da stanza, deixou de devolver somente o relay sem credencial e
manteve as respostas para os relays autenticados.

| Rede do aparelho | Caminho remoto confirmado | `recvOk`/`opusOk` | Resultado |
| --- | --- | ---: | --- |
| dados móveis | `bsb1c01` por IPv6 | `245/245` | áudio bidirecional, zero erro SRTP/Opus |
| Wi-Fi | `gru2c01` por IPv4 | `116/116` | áudio bidirecional, zero erro SRTP/Opus |

Esse A/B valida o dual-stack do relay WhatsApp e o filtro de `relaylatency`. O
serviço SIP/VoIP permaneceu em IPv4 nos dois canários, comprovando que as duas
pernas são terminadas independentemente e não dependem de NAT64.

## Roteiro para novos canários

Executar uma chamada de saída e uma de entrada com destino externo ao conjunto de
sessões locais. Para cada call-id, confirmar nesta ordem:

1. `native relay transport started`;
2. `native relay data channel open`;
3. `WASM stun allocate sent` e `keepalive first ping sent`;
4. `stun allocate success`/pong sem Binding Request de origem local;
5. `audio sent` com contador crescente;
6. `rtp packet received` com `rtpRecv > 0` (PT 120 ou 121);
7. ausência de `srtp recv error`; se houver, conferir `recvJids` e o SSRC do pacote;
8. `audio recv stats` com `decodeOk > 0`;
9. no worker VoIP, frames `uno_to_voip` recebidos e RTP SIP remoto não nulo.

Se os passos 1-4 passarem e o 6 continuar zerado, capturar os pacotes recebidos pelo
DataChannel e o allocate completo da mesma chamada. Se o 6 passar e o 7 falhar, a
investigação muda de relay para identidade/chave. Se o 8 passar mas o 9 falhar,
somente então o problema está no WebSocket/bridge SIP.

## Lacunas separadas do reparo de áudio 1:1

- SRTCP de áudio/vídeo e relatórios de recepção;
- vídeo H.264, orientação e PLI/FIR;
- jitter buffer por timestamp no plugin;
- chamadas em grupo, rekey de epoch, mixer e encaminhamento SFU;
- app-data/reações, call links, waiting room, raise hand e screen share;
- estado público `active` distinguindo relay aberto do primeiro áudio remoto.

Essas lacunas não devem ser misturadas com a validação urgente da chamada direta de
áudio. Primeiro deve ser comprovado o caminho bidirecional acima; depois, cada
capacidade recebe contrato, adaptador, teste e documentação próprios.

## Verificação do estado atual

- 210/210 testes do plugin incorporado passaram no mesmo runtime Node usado na verificação;
- builds TypeScript CommonJS e ESM do plugin passaram;
- `git diff --check` passou nos arquivos da auditoria;
- a revisão 09 foi incorporada à imagem unificada `4.0.29`;
- o hostpatch `pcm-frame-20260828-01` foi aplicado somente no worker Zapo sobre
  `4.0.29`; o serviço VoIP não foi reiniciado;
- as oito chamadas reais descritas acima passaram com áudio bidirecional em
  iPhone 16 e Galaxy S9e;
- cinco chamadas adicionais validaram o framing PCM variável. No destinatário
  que reproduzia a falha, 474 decodes viraram 787 quadros válidos e os 787
  chegaram ao bridge, sem erro SRTP, Opus ou PCM;
- o serviço SIP/VoIP não precisou ser reiniciado porque a mudança validada está
  no plugin incorporado executado pelo worker.

O framing PCM passa a integrar `@vipertec/zapo-voip` `1.0.0-viper.6` e a imagem
unificada `v4.0.30`. Após atualizar, o canário deve ser repetido sem mounts
sobre `dist` antes da remoção do hostpatch operacional.

Os testes automatizados provam envelopes, vetores, recuperação e contratos
locais. Os canários provam o caminho normal com relay vivo e duas chamadas
simultâneas; somente o failover forçado continua pendente neste conjunto de
critérios.
