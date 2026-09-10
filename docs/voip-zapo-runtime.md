# Runtime VoIP Zapo: dependencias, protocolo e solucao de midia

Estado consolidado em 2026-08-28. Este documento e a fonte canonica para
entender onde cada parte da telefonia executa, quais dependencias pertencem a
cada processo e quais correcoes estabilizaram o audio 1:1.

## Resumo executivo

A imagem Docker e unica, mas nao existe um unico processo Node nem um unico
`node_modules`. A mesma tag contem dois runtimes isolados:

```text
WhatsApp
  <-> sinalizacao, relay, RTP/SRTP e codec
worker Zapo: /home/u/app/dist + /home/u/app/node_modules
  <-> WS autenticado /v1/bridge/zapo + PCM Float32 16 kHz
telefonia: /home/u/app/voip/dist + /home/u/app/voip/node_modules
  <-> SIP/WebRTC ou SIP/RTP
ramais
```

- o worker Zapo e o unico dono da sessao, credenciais, Signal, JIDs/LIDs,
  sinalizacao de chamada e midia do WhatsApp;
- o servico de telefonia nao abre uma segunda sessao Zapo; ele cuida de SIP,
  ramais, roteamento, gravacao e conversao de audio;
- o transporte de relay e implementado pelo vendor da ViperTec e pelo helper
  nativo empacotado na imagem; nao existe processo externo de chamada;
- cada endereco numerico anunciado pelo relay WhatsApp abre um socket explicito
  da propria familia (`udp4` em `0.0.0.0` ou `udp6` em `::`); IPv4 e IPv6 podem
  coexistir na perna WhatsApp sem alterar a familia SIP/RTP do ramal;
- uma resposta `452 Xor Relayed Address Mismatch` no `Allocate` IPv6 coloca
  somente aquele candidato em quarentena, encerra seu keepalive e preserva os
  candidatos IPv4 paralelos; isso evita retry continuo e interferencia no
  relay valido;
- no atributo WASM `0x0016`, o IPv6 usa o magic cookie seguido do transaction
  ID interpretado como tres palavras `uint32` little-endian. Esse formato foi
  derivado pela correlacao exata entre request e resposta `452`; o IPv4
  preserva o encoding anterior sem qualquer alteracao;
- RabbitMQ nao transporta audio. O bridge usa JSON para controle e frames
  binarios `VPA1` para PCM.

O WebSocket worker Zapo -> VoIP continua na rede Docker atual. O bridge termina
as duas pernas de midia independentemente, portanto um relay WhatsApp IPv6 pode
alimentar um ramal SIP IPv4 sem NAT64. O caminho de relay IPv6 foi validado ao
vivo em 2026-08-21, depois dos KATs de `te2`, STUN, bind e rejeicao de familia
incompativel. A validação do framing PCM variável foi feita primeiro como
hostpatch somente no worker e promovida para a imagem unificada `v4.0.30`.

## Fontes de verdade do build

O worker Zapo usa o `package.json` da raiz deste repositorio. Nao existe um
`package.json` exclusivo para `unoapi-worker-zapo`.

O processo VoIP usa o manifesto do repositorio separado
`ViperTecCorporation/viperconnect-voip-service`. O workflow o baixa para
`_build/voip-service` e o Docker executa `npm ci` em uma etapa propria. A pasta
`_build/` local e temporaria, esta no `.gitignore` e pode conter uma copia
antiga; ela nunca deve ser tratada como fonte de verdade. A imagem de release
registra a revisao exata da branch integrada para permitir reproducao e rollback.
O workflow resolve o checkout para um SHA antes do Docker build, grava esse SHA
no label `io.vipertec.viperconnect.voip.revision` e em
`/home/u/app/voip/SOURCE_REVISION`. Em publicacao manual, informe o SHA do VoIP
em `voip_ref`; usar apenas uma branch movel nao e suficiente para reproduzir uma
imagem antiga.

Tags `v*` do repositório VoIP validam o código e geram os pacotes nativos, mas
não disparam a imagem unificada. Para publicar a imagem, primeiro envie a branch
VoIP `codex/zapo-uno-voice-bridge` e depois publique a tag correspondente neste
repositório. O workflow do ViperConnect resolve a branch para um SHA imutável,
executa os testes do VoIP e publica as tags semânticas e `latest`. O workflow
atual não usa `repository_dispatch` nem `UNIFIED_IMAGE_DISPATCH_TOKEN`. Se o
repositório VoIP for privado, configure `VOIP_REPOSITORY_TOKEN` no ViperConnect
para o checkout do SHA exato.

A imagem unificada `v4.0.30` incorpora o VoIP `v0.1.65`, revisão
`8fb39da48a7c98ff97f104ea46a46775ac5c3f5e`. O SHA exato é resolvido e gravado pelo
workflow no label e em `SOURCE_REVISION`. Ela mantém SIP, RTP, media bridge,
internal RTP proxy e Coturn em IPv4/IPv6 paralelos. O IPv4 anterior permanece
ativo e o endereço público IPv6 é configurado por hostname/ENV, sem gravar o
prefixo dinâmico da Starlink na imagem.

A configuração por família, o Coturn, as portas e a validação operacional estão
consolidados em
[`docs-site/guide/voip-ipv6.md`](../docs-site/guide/voip-ipv6.md).

O estágio `voip-builder` também valida o JavaScript compilado antes de permitir
a imagem: `voice_router.js` deve usar `outbound_line`, `maxConcurrentCalls` e os
erros de capacidade por linha. O build falha se reaparecerem
`no_available_voip_slot`, `outbound_slot`, `account.slots`, `deviceSlotIds` ou os
seletores legados de slot. Assim uma regressao local nao pode ser publicada
silenciosamente na imagem unificada.

O `Dockerfile` copia os dois grafos para caminhos diferentes e o entrypoint
seleciona o executavel:

| `UNOAPI_PROCESS_ROLE` | Executavel | Dependencias |
| --- | --- | --- |
| `worker` com `UNOAPI_WORKER_ENGINE=zapo` | `/home/u/app/dist/src/cloud.js` | `/home/u/app/node_modules` |
| `voip` | `/home/u/app/voip/dist/app.js` | `/home/u/app/voip/node_modules` |

## Dependencias do worker Zapo

As dependencias que formam o caminho de chamada sao:

| Pacote/componente | Versao | Papel |
| --- | --- | --- |
| `zapo-js` | `1.8.1` | cliente Zapo, sessão, transporte e primitivas de protocolo |
| `@vipertec/zapo-voip` | `1.0.0-viper.6` (`file:vendor/zapo-voip`) | plugin vendorizado de sinalização e mídia VoIP |
| `libmlow-wasm` | `0.1.1` | encode/decode MLow e RFC Opus selecionado por chamada |
| `ws` | `^8.21.1` | bridge autenticado com o processo de telefonia |
| `relay-bridge` | binario Go estatico | UDP, DTLS, SCTP e DataChannel direto com o relay |

O pacote `@vipertec/zapo-voip` declara somente `zapo-js` e `libmlow-wasm` como
peer dependencies. Ele não depende de uma implementação Node de WebRTC. A atualização
Zapo 1.8.1 não modificou o contrato de chamadas usado pelo vendor. A atualização
atua no retry de mensagens, no autor persistido pelo history sync e no sidecar de MP4.
A versão VoIP 0.1.65 acrescenta suporte seguro a proxies SIP/SBC com porta de
sinalização personalizada, preservação de múltiplos `Via`, re-INVITE e relay RTP
privado autorizado por allowlist. A composição permanece coordenada e
reproduzível pelo SHA acima.

O helper nativo e compilado no Docker com estas versoes Pion fixadas no
`go.mod`:

- `github.com/pion/datachannel v1.6.0`;
- `github.com/pion/dtls/v3 v3.1.2`;
- `github.com/pion/sctp v1.9.4`;
- `github.com/pion/logging v0.2.4`.

O `protobufjs` fixado em `resolutions` pertence ao grafo geral de protocolo. Ele
nao codifica o bridge PCM. Os nove StreamDescriptors do Allocate STUN sao
gerados no proprio vendor e enviados no atributo `0x4024`.

O build da imagem instala apenas o grafo de producao do worker e executa
`scripts/check-zapo-runtime-graph.mjs` para impedir que imports ou artefatos
fora do runtime Zapo entrem no `dist` publicado.

## Dependencias do processo VoIP

O processo VoIP recebe o PCM pronto; ele nao decodifica MLow, nao deriva chave
SRTP e nao abre o relay do WhatsApp. No caminho Zapo ativo, os componentes
centrais sao `express`, `ws`, `zod`, os gateways SIP e
`ZapoBridgeRegistry`/`ZapoBridgeCallService`.

As dependencias centrais do manifesto da telefonia sao:

| Dependencia | Uso real |
| --- | --- |
| `@roamhq/wrtc` | perna SIP/WebRTC dos ramais no navegador; nao e o relay WhatsApp |
| `ws` | WebSocket SIP e bridge Zapo autenticado |
| AWS SDK | armazenamento e acesso a gravacoes quando configurado |

O processo de telefonia inicia diretamente a bridge Zapo, os gateways SIP e os
servicos administrativos. Ele nao abre sessao de WhatsApp, nao possui
pareamento proprio e nao executa tarefas de credenciais paralelas.

## Contrato entre os processos

O worker abre `WS /v1/bridge/zapo` com Bearer token. A primeira mensagem e um
`bridge.hello` contendo sessao, geracao, worker e capacidades. O servidor aceita
somente a geracao mais nova para aquela sessao.

Controle usa JSON e inclui `call.incoming`, `call.state`, `call.command`,
`call.ended`, abertura/fechamento de stream e heartbeat. Audio usa um envelope
binario fixo:

- magic `VPA1`;
- protocolo `1`;
- direcao, `streamId` e sequencia no cabecalho de 16 bytes;
- 960 amostras `Float32LE`, mono, a 16 kHz;
- isolamento por `session + callId + streamId`.

No sentido WhatsApp para SIP, o vendor decodifica o Opus remoto e publica PCM
`uno_to_voip`. No sentido SIP para WhatsApp, a telefonia envia PCM
`voip_to_uno`, e o vendor aplica backpressure, codec, RTP e SRTP.

O decoder pode devolver durações legítimas diferentes de um quadro do bridge,
inclusive até 1.920 amostras. Cada chamada possui um acumulador independente:

- saídas maiores são divididas em blocos de 960 sem truncamento;
- fragmentos menores aguardam o próximo decode, sem preenchimento artificial
  com silêncio;
- somente quadros completos atravessam o WebSocket;
- a sobra incompleta é descartada no cleanup e nunca contamina outra chamada.

O resumo `call stats` diferencia `srtpErrors` de `pcmDeliveryErrors` e publica
`pcmDeliveredFrames` e `pcmPendingSamples`. Um erro posterior ao decode não é
mais classificado como falha de autenticação SRTP.

## Contrato de relay implementado

O vendor foi auditado contra vetores publicos de protocolo e implementa os
contratos de fio necessarios para chamadas 1:1:

- transporte direto `UDP -> DTLS client -> SCTP client -> DataChannel`, sem
  ICE, SDP ou `RTCPeerConnection`;
- DataChannel pre-negociado, id `0`, label `pre-negotiated`;
- Allocate STUN com token, endpoint e nove descritores de stream;
- Allocate e ping imediatos, renovados no keepalive; o cliente responde Binding
  Requests iniciados pelo relay, mas nao inicia Binding Request;
- derivacao e ordem dos SSRCs `[0,1,4,2,3,5,7,8,6]`;
- HKDF por `callKey`, identidade exata do participante, RTP/SRTP/SRTCP, ROC e
  replay window;
- RTP de audio PT `120` ou `121`, sequencia inicial `1`, timestamp `0` e marker
  preservado para a primeira fala real;
- ordem de campos do offer e aceite direto da entrada apos o primeiro
  `mute_v2` do caller;
- preferencia de relay FNA no inbound e non-FNA autenticado no outbound.

## Responsabilidades da Zapo e extensoes ViperTec

A Zapo continua sendo dona da sessao, plugin host, Signal, privacy token,
resolucao LID/device, envio/recepcao das stanzas e stores.

O fluxo final e deliberadamente hibrido:

- inbound: o `Answer` apenas confirma o estado local e abre o relay selecionado,
  sem enviar `mute_v2` ou `transport` proativamente; espera o primeiro
  `mute_v2`, envia o accept direto com a taxa negociada, `net medium="2"`,
  `encopt` e metadata, sem uma segunda `callKey`, e depois responde com ACK de
  classe `call` tipado como `mute_v2`;
- outbound: o ACK do offer negocia codec e dispara o preaccept do caller; o
  preaccept remoto envia `relaylatency` e transport inicial `0/0`; o accept
  remoto envia transport `1/1` e `mute_v2(0)` ao device exato que atendeu;
- `voip_settings` escolhe codec por chamada: somente
  `use_mlow_codec_v1="false"` usa RFC Opus/8 kHz; ausente, verdadeiro ou
  malformado usa MLow/16 kHz. A escolha e congelada depois do preaccept;
- chamadas entre duas sessoes locais possuem uma perna inbound espelhada. O
  guard encerra somente essa perna interna, sem transmitir `terminate` e sem
  disputar a perna outbound.
- um `<reject>` recebido para uma chamada que nao foi iniciada pela sessao e
  ignorado. O encerramento remoto de uma entrada continua sendo representado
  por `<terminate>`, enquanto o `<reject>` de uma chamada iniciada localmente
  conserva o comportamento normal. Esse guard atua apenas na sinalizacao e nao
  altera relay, RTP, codec, offer/answer ou a ponte de audio.

Sao extensoes proprias da ViperTec: o helper Go integrado a imagem, o bridge
PCM para SIP, a protecao da perna local, a negociacao de codec concluida no
vendor e a recuperacao sequencial de relay.

## Causa e solucao apos os testes

O problema nao era uma porta fixa, RabbitMQ, call-id, privacy token, SIP ou um
modelo especifico de aparelho. Nos casos iniciais, o relay e o DataChannel
abriam, Allocate/Pong continuavam, o aparelho recebia o audio do SIP e nao havia
erro SRTP, mas o relay nao entregava audio remoto ao worker (`rtpRecv=0`).

A primeira causa estrutural foi o transporte com `RTCPeerConnection/ICE`. Ele
emitia Binding Requests e colocava o relay em um modo de consentimento diferente
do fluxo Web direto esperado. O helper Go eliminou ICE e passou a reproduzir a
pilha direta.

Depois disso, foram alinhados como um unico contrato a sinalizacao, identidade
do device, SSRC/SRTP, PT/marker RTP, codec por chamada e a perna espelhada. Nao
foi uma troca isolada de biblioteca ou de porta.

Os logs tambem provaram um caso intermitente em que o plano de controle do relay
continuava vivo, mas chegavam zero ou poucos frames Opus autenticados. Para nao
destruir a chamada nem abrir relays em paralelo, o vendor agora:

1. preserva todos os `te2` reais na ordem recebida;
2. abre somente um candidato por vez;
3. no outbound, pode trocar apos 3 s sem transporte/controle;
4. no outbound, pode trocar apos 1,5 s sem o primeiro Opus autenticado;
5. no outbound, pode trocar apos stall de 3 s quando chegaram apenas 1 a 9
   frames autenticados;
6. apos 10 frames autenticados, considera a midia estabelecida e para o
   watchdog para nao confundir silencio/DTX com falha;
7. nao troca durante mute remoto ou `on_hold`;
8. preserva codec, RTP, SRTP/ROC, SSRCs, subscriptions e PIDs;
9. o caminho ativo usa sempre IP e porta anunciados pelo `te2`; a variante
   sintetica `3480` existente no normalizador fica explicitamente desabilitada.

No inbound 1:1, zero RTP inicial ou stall de midia nao autorizam reeleicao
silenciosa depois do accept. O primeiro relay permanece selecionado enquanto o
plano de controle estiver vivo e somente uma falha real do transporte/controle
permite avancar para o proximo candidato.

Os vetores publicos fornecem a referencia para a escolha inicial e os contratos
de fio, mas esse failover depois da abertura e uma extensao local.

Para investigar diferencas entre Wi-Fi e dados moveis sem mudar o protocolo,
`voip_diag inbound_call_envelope` correlaciona o JID bruto com o JID normalizado,
tag, arvore de filhos, nomes de atributos e tamanhos de conteudo. Apenas uma
allowlist de atributos de roteamento tem valores registrados. Conteudo
criptografado, texto, tokens e chaves nunca entram no log. O accept direto usa
o mesmo resumo em `voip_diag inbound_accept_sent`.

Para diagnosticar a eleicao de relay, cada resposta enviada ao
`relaylatency` gera `voip_diag outbound_relaylatency_response` com o stanza ID,
nome do relay e a indicacao `authenticatedRelay`. ACKs e receipts de chamada
geram `voip_diag inbound_call_ack_envelope` e
`voip_diag inbound_call_receipt_envelope`; a correlacao e feita pelo stanza ID.
Tokens, chaves, conteudos e valores de atributos fora da allowlist continuam
fora dos logs.

No fluxo inbound, o ACK da stanza `relaylatency` continua sendo enviado para
preservar o protocolo. A resposta de medicao e limitada aos nomes de relay que
possuem endpoint utilizavel no offer corrente: protocolo suportado, chave e
token binario. Um probe sem essas credenciais nao e convertido em candidato e
gera `voip_diag unauthenticated_relaylatency_skipped`; os demais probes da
mesma stanza continuam sendo respondidos normalmente.

O A/B de 2026-08-21 confirmou a causa operacional: em dados moveis, o peer
media `fcgb9c01` com menor latencia, mas o offer autenticava somente outros
relays. Depois que apenas a resposta desse probe sem credencial foi omitida, o
primeiro RTP chegou pelo IPv6 autenticado de `bsb1c01`. No Wi-Fi, todos os
probes pertenciam ao offer e o primeiro RTP continuou chegando normalmente
pelo IPv4 de `gru2c01`.

## Superficies administrativas da imagem integrada

A Uno expoe uma fachada autenticada em `/admin/voip` e nunca entrega o token do
servico ao navegador. O bootstrap agrega configuracao, linhas Zapo, chamadas,
registros SIP/WebRTC, locks, a primeira pagina do historico e o resumo de
gravacoes.

O contrato administrativo consolidado inclui:

- empresas com fuso horario e transcricao/resumo por IA isolados por empresa;
- contas com integracao opcional de gravacao no Chatwoot e controle de nota
  privada;
- linhas e sessoes Zapo com `maxConcurrentCalls` entre 1 e 32, padrao 2, sem
  cadastro ou selecao de dispositivo no Manager;
- ramais SIP/WebRTC com varios registros simultaneos e desconexao individual;
- distancia por grupo de ramais, onde o menor numero possui maior prioridade;
- historico com busca, periodo, pagina e `pageSize` limitado a 100;
- gravacao local ou S3 compativel, MP3/WAV/GSM, retencao, resumo por linha,
  reproducao autenticada e limpeza por conta;
- audio MP3/WAV de ate 15 MB por grupo de transferencia;
- simulacao de roteamento inbound/outbound e liberacao explicita de locks.

No Manager, chamadas ativas, historico, reproducao/download e resumo de
armazenamento ficam na mesma aba **Chamadas e gravacoes**. O servico VoIP nao
possui frontend administrativo nem cadastro proprio de usuarios; a unica
interface administrativa e a fachada autenticada da Uno.

Configuracoes e segredos sao persistidos pelo servico de telefonia. Respostas
administrativas omitem os segredos; campos secretos vazios preservam os valores
ja salvos.

## Evidencia de validacao

Em 2026-08-21, a revisao 09 foi validada em duas entradas consecutivas na mesma
sessao e ramal, sem reiniciar o processo VoIP:

| Rede | Relay confirmado | Familia | Worker | Ponte SIP | Resultado |
| --- | --- | ---: | --- | --- | --- |
| dados moveis | `bsb1c01` | IPv6 | `recvOk=245`, `opusOk=245`, `srtpErrors=0` | 1.722 pacotes recebidos e 1.704 enviados | bidirecional |
| Wi-Fi | `gru2c01` | IPv4 | `recvOk=116`, `opusOk=116`, `srtpErrors=0` | 1.024 pacotes recebidos e 1.013 enviados | bidirecional |

O relay sem credencial `fcgb9c01` foi apenas ignorado na resposta de latencia;
o ACK do evento original, as respostas dos relays autenticados, accept,
receipt, SIP e WebSocket permaneceram ativos. Isso comprova IPv4/IPv6 no relay
WhatsApp e regressao Wi-Fi sem atribuir o resultado a uma imagem ainda nao
publicada.

Em 2026-08-05, o hostpath da revisao corrente foi validado em oito chamadas de
audio bidirecional:

| Aparelho | Direcao | Quantidade | Resultado |
| --- | --- | ---: | --- |
| iPhone 16 | entrada | 2 | bidirecional |
| iPhone 16 | saida pelo SIP | 2 | bidirecional |
| Galaxy S9e | entrada | 2 | bidirecional |
| Galaxy S9e | saida pelo SIP | 2 | bidirecional |

Os contadores de audio remoto autenticado foram `117`, `39`, `51`, `86`, `171`,
`89`, `66` e `40`, sem erro SRTP ou Opus, e a ponte SIP apresentou trafego nos
dois sentidos. Isso tambem descarta a hipotese de incompatibilidade geral de um
aparelho antigo com MLow.

As oito chamadas estabilizaram no primeiro relay. Portanto, o caminho normal
esta comprovado ao vivo. A recuperacao sequencial esta coberta por testes
automatizados, mas ainda precisa de um canario que provoque deliberadamente um
primeiro relay degradado.

Em 2026-08-06, a concorrencia de duas chamadas na mesma sessao
`5566999554300` foi comprovada nas duas direcoes:

| Direcao | Call IDs | Sobreposicao ativa | Resultado |
| --- | --- | ---: | --- |
| saida SIP | `97CCA774AB66615D454FF52D080ADA26` e `B21EF71FFC7747D9D282735686088F5A` | 5,659 s | ambas bidirecionais, fim normal |
| entrada | `006362448DA416EF0DFFFEF840074E2C` e `00F1670C760FAAFDE612387F346B28D0` | 10,927 s | ambas bidirecionais, fim normal |

Nos quatro fluxos houve RTP e PCM nos dois sentidos, com `srtpErrors=0` e
`opusErr=0`. Nao ocorreu `no_available_voip_slot` nem erro de capacidade. Isso
valida o limite padrao `maxConcurrentCalls=2` sem slots de dispositivo; uma
combinacao simultanea mista, com uma entrada e uma saida, nao fez parte desse
canario.

No mesmo dia, a linha `5566996222471` validou o guard de rejeicao inbound no
call ID `004702FE66D3CFC1D5E188C1EA670D8F`: tocou os ramais, o primeiro atendeu,
o segundo encerrou como `answered_elsewhere`, a chamada ficou ativa e terminou
por `extension_bye`, com audio bidirecional e zero erro SRTP/Opus. A regra e
generica por direcao; o numero nao esta hardcoded.

Antes de congelar o estado no Git, o mesmo CommonJS foi revalidado em quatro
chamadas adicionais. Os call IDs
`00BA672F9419331B09FF04EB85A88531`,
`00B17BF9607D128100B831F70288C3E7`,
`93A38685363FB784FD20A3A7460A4203` e
`002709E2597F798D574F45B50D605BB7` encerraram normalmente, com
`recvOk`/`opusOk` de 91, 83, 50 e 44 e zero erro SRTP. Os hashes aplicados sao:

| Arquivo | SHA-256 |
| --- | --- |
| `dist/call/WaCallMediaSession.js` | `87d0011588c10451ef68301a22128264a327ac2e8aab8641a5834be35d6c61d8` |
| `dist/call/WaCallManager.js` | `f49be3653f094e78de8b8a71f9d56934060c080be09f310d6e042c0ed2f7d511` |
| `dist/signaling/bridge.js` | `d99a6e28ab14975f15dc1fa682a45ceb868d9a5fc124fde81172c883d720f9cb` |

Em 2026-08-28, uma nova falha intermitente foi isolada depois do decode MLow:
o decoder podia devolver uma duração válida diferente de 960 amostras, mas o
bridge rejeita corretamente qualquer frame `VPA1` fora desse tamanho. O erro
era registrado como `srtp recv error` mesmo quando SRTP e Opus já tinham sido
processados, dificultando o diagnóstico.

O hostpatch `pcm-frame-20260828-01` foi aplicado somente ao worker Zapo sobre a
imagem `4.0.29`; o serviço VoIP não foi reiniciado. Quatro chamadas com iPhone
16 e Galaxy S9e passaram com áudio bidirecional. Uma quinta chamada para o
destinatário que reproduzia a falha confirmou o caminho de divisão: 474
decodes produziram 787 quadros completos e um resto de 320 amostras. O serviço
VoIP recebeu exatamente os mesmos 787 quadros, 773 com áudio não nulo, sem erro
SRTP, Opus, PCM ou bridge. Essa correção foi promovida para
`@vipertec/zapo-voip` `1.0.0-viper.6` e para a imagem unificada `v4.0.30`.

## Regras para manutencao e release

- nao reintroduzir ICE/PeerConnection no relay WhatsApp;
- nao forcar `3478` ou `3480` no caminho ativo; usar o `te2` selecionado e
  manter `includeWebTokenFallback: false` na selecao 1:1;
- nao abrir todos os relays ao mesmo tempo nem reordenar `te2` por RTT;
- nao inventar `:0` na sinalizacao; usar o device observado e testar variantes
  bare/`:0` somente durante autenticacao SRTP de recepcao;
- nao trocar o accept direto ou remover os controles outbound sem um A/B
  controlado de entrada e saida;
- toda mudanca de envelope, relay, codec ou criptografia exige teste dedicado;
- antes de publicar, executar a suite do vendor, builds CJS/ESM, teste do helper
  Go e canarios inbound/outbound;
- registrar no artefato a revisao exata do repositorio VoIP incorporado. A branch
  configuravel do workflow e pratica, mas uma tag nao deve ficar sem
  rastreabilidade do segundo repositorio.
- hostpaths servem somente para canario. A promocao exige imagem unificada com
  os SHAs exatos, sem mounts sobre `dist`; recriar um container apenas com o
  Compose base remove um hostpath temporario.
- cada tag Git `v*` publica a referencia semantica correspondente e tambem
  atualiza `latest`; ambas devem apontar para o mesmo digest da imagem integrada.

O processo de empacotamento e release esta em `docs/voip-fork-release.md`.
