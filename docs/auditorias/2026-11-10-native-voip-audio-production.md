# Coleta de áudio nativo: DEV e produção — 10/11/2026

Atualização de 13/11/2026: este documento preserva o histórico da investigação,
incluindo hipóteses descartadas e pendências superadas. A consolidação posterior
incluiu correções de SDP/ICE/TURN, retomada da mesma chamada por até 60 segundos
e aviso local misturado à voz. A build 4161307 foi instalada no Android e
validada/enviada ao App Store Connect; o usuário confirmou o bip no teste real.
Não extrapolar essa confirmação para todos os modos de atendimento ou redes,
nem confundir commits publicados com uma nova imagem ou implantação da stack.

Estado atualizado: defeito de destino SDP pós-nomeação demonstrado e corrigido
no código VoIP; hotfix pontual aplicado somente ao container VoIP às 19:39.
Regressões e ensaio isolado com o motor real aprovados; confirmação de áudio
em aparelhos após o hotfix ainda pendente. As seções iniciais registram as
hipóteses anteriores, supersedidas pela conclusão ao final. Sem alteração da
RB, do Coturn ou do worker WhatsApp. Horários locais: America/Cuiaba (UTC−04).

## Escopo e coleta

- Produção: sessão `5566996269251`, ramal `1001`, iPhone 16/iOS no cliente nativo.
- Origem/destino DEV: sessão `5566936183915`, SIP/RTP UDP com PCMU.
- Controle sem DEV: WhatsApp real `5566996222471`.
- Produção observada: imagem ViperConnect `4.0.41`, pacote VoIP `0.1.69`.
- Logs de worker/VoIP e diagnóstico HTTP existente por sessão/call ID, somente leitura.
- Nenhuma mídia, chave SRTP, credencial, SDP bruto ou gravação foi exportada.
- Contadores RTP e estado ICE/DTLS não provam escuta; a escuta foi confirmada pelo usuário.

## Ensaios observados na rede móvel

| Ensaio | Call ID | Resultado confirmado |
| --- | --- | --- |
| DEV → produção → iPhone | `070777A8925F9422E9D68E0CD2B250B0` | iPhone em chamada, DEV continuou com ringback; sem áudio útil. Encerrar no DEV não encerrou no iPhone. |
| iPhone/1001 → DEV | `FADBF4F876A75C9ADE548F8E3C05A2B3` | iPhone ouve o DEV; DEV não ouve o iPhone. |
| WhatsApp real → produção → iPhone | `0040A47F842618B5A6ECF7053E4A7F2F` | Usuário confirmou áudio nos dois sentidos, com ambos os aparelhos na rede móvel. |
| iPhone/1001 → WhatsApp real | `D7143023348D26FFA62586489D169F80` | iPhone ouve o WhatsApp; WhatsApp não ouve o 1001. Reproduz a saída unilateral sem envolver DEV. |

Comparação posterior, com **somente o iPhone no Wi-Fi**, confirmada pelo usuário:

| Ensaio | Call ID | Resultado confirmado |
| --- | --- | --- |
| iPhone/1001 no Wi-Fi → WhatsApp real | `81D6432A1554B392B9B45628DA9F1400` | Mesmo problema de saída unilateral observado na rede móvel. |

Comparações Android e telefonia interna solicitadas depois:

| Ensaio | Call ID | Resultado confirmado |
| --- | --- | --- |
| Android/1010, linha `5566999554300` → WhatsApp `5566996269251` | `BB9FD185F19254C0AE7C962013387DC1` | Ponta WhatsApp sem áudio do Android; servidor também não recebe RTP do originador. Rede Android não confirmada. |
| Interna 1010/Android → 1001/iPhone | `b4bfa45e79777d55` | 1010 ouve 1001, mas 1001 não ouve 1010. Sem WhatsApp/Zapo no caminho. |
| Interna 1001/iPhone → 1010/Android | `5ca33d44cb7a85bc` | Usuário confirmou inversão do sintoma; servidor não recebe RTP do novo originador (1001). |

## Evidências por trecho

### 1. DEV → produção

- O worker DEV terminou com `relayPackets=3801`, `srtpErrors=3259`, `recvOk=0`,
  `pcmDeliveredFrames=0`. Erro explícito: `SRTP auth tag verification failed`.
- DEV permaneceu sem `acceptedByJid`; as identidades de recepção de áudio foram
  inicializadas para o participante sem device e device `0`, enquanto produção
  enviou usando a identidade de device `24`. Os identificadores de chave não foram exportados.
- Na janela observada, DEV recebeu `preaccept`, `relaylatency` e `interruption`,
  sem a sequência de aceite final observada no controle com WhatsApp real.
- O VoIP de produção recebeu RTP do iPhone (última amostra: 11027 pacotes) e
  enviou 10785 pacotes. O worker de produção decodificou 3268 quadros vindos do DEV,
  mas todos chegaram à ponte SIP sem sinal de voz (`wasmNonZeroFrames=0`).
- DEV encerrou às **17:52:07.415** (`extension_bye`); produção só encerrou às
  **17:52:34.760**, após o usuário desligar no iPhone. Não é um encerramento propagado com sucesso.

Essa falha envolve sinalização/identidade SRTP entre plugins e não pode ser
atribuída somente ao cliente iOS ou à falta de conectividade RTP.

### 2. iPhone/1001 → DEV

- Produção manteve ICE/DTLS `connected`, sinalização `stable`, par ICE nomeado.
- Última amostra antes de encerrar: 7487 pacotes RTP enviados ao iPhone,
  **zero pacotes/bytes RTP recebidos dele**.
- A ponte gerou quadros de silêncio para a origem SIP: `remoteNonZeroFrames=0`.
  A existência de callbacks `RTCAudioSink` não prova recepção de voz: a biblioteca
  pode entregar silêncio sem RTP recebido.
- O worker de produção recebeu/decodificou 2522 quadros do DEV, sem erro SRTP.
- Houve renegociação do diálogo WebRTC em `21:54:22Z` aproximadamente; isso é
  correlação temporal, não demonstra por si só defeito na renegociação.
- Encerramento de produção observado às **17:56:57.796**, por `extension_bye`.

### 3. WhatsApp real → iPhone

- Aceite SIP 200 e mídia conectada; o WhatsApp enviou `mute_v2`, seguido do
  aceite direto do plugin e confirmação de mídia autenticada.
- Última amostra/fechamento: 1861 pacotes RTP enviados ao iPhone e 1912 recebidos;
  3287 quadros SIP não nulos e 164 quadros do provedor não nulos.
- Usuário confirmou escuta bidirecional. A chamada foi fechada às **17:59:16.240**
  na ponte WebRTC; a origem exata do encerramento deve ser conferida nos eventos.

### 4. iPhone/1001 → WhatsApp real

- O WhatsApp real enviou `accept`; o worker passou a `active` e o ringback parou.
- O worker recebeu áudio autenticado do WhatsApp, com `decodeOk` crescente e
  `decodeErr=0` nas amostras coletadas.
- Às **18:00:56.024**, a ponte tinha 4331 pacotes RTP enviados ao iPhone e
  **zero pacotes/bytes RTP recebidos dele**, com ICE/DTLS conectados e sinalização estável.
- Também apresentou `remoteNonZeroFrames=0`, embora o áudio do WhatsApp entregue
  ao iPhone tivesse sinal de voz. Reproduz a ausência de subida de áudio sem DEV.
- Amostra final às **18:01:16.025**: 5315 pacotes RTP enviados ao iPhone, zero
  recebidos. Encerramento às **18:01:17.639**.

### 5. Repetição da saída com iPhone no Wi-Fi

- Início da ponte às **18:02:18.281**; usuário confirmou que o iPhone estava no Wi-Fi.
- Às **18:02:58.285**: 1887 pacotes RTP enviados e **zero recebidos**; ICE/DTLS
  conectados, sinalização estável, `remoteNonZeroFrames=0`, áudio real do WhatsApp presente.
- A assinatura de mídia é a mesma das duas saídas anteriores. As amostras das
  saídas apresentam papel ICE `controlled`, candidatos `host/host`; o controle
  de entrada bem-sucedido apresentou `controlling`, candidatos `prflx/srflx`.
  Isso é uma diferença observada, não prova de causalidade nem de endereço IP específico.
- Às **18:02:59.439**, chegou `terminate` do WhatsApp. A ponte foi fechada às
  **18:02:59.447**. Consulta posterior confirmou lista de chamadas ativas vazia.

### 6. Originação do Android/1010 para WhatsApp

- O usuário confirmou a origem `5566999554300` e o destino `5566996269251`.
  Não é a mesma linha do teste iOS, portanto não isola sozinho sistema operacional.
- Ponte iniciada às **18:06:14.291**; fechamento às **18:07:48.783**.
- Última amostra: 4364 pacotes RTP enviados ao Android e **zero recebidos**;
  ICE/DTLS conectados, sinalização estável, `remoteNonZeroFrames=0`.
- Áudio recebido de WhatsApp chegou à ponte (`wasmNonZeroFrames=644` no fechamento).
- A tentativa curta `070C34249F5EB911395B0F16C41D55BD`, às 18:05:55–18:05:56,
  terminou antes de gerar amostra RTP periódica; não foi usada como prova de áudio.

### 7. Chamada interna 1010 → 1001

- Fluxo SIP/WebRTC interno, sem worker WhatsApp no transporte de voz.
- Identificador principal: `b4bfa45e79777d55`.
- 1010/Android: extensão `b7731964-08f8-428f-b7fd-1be7164e78cc`.
  Fechamento às **18:10:31.535**: zero RTP recebido, 3112 pacotes enviados,
  `remoteNonZeroFrames=0`; a ponte recebeu 2083 quadros de voz do outro ramal.
- 1001/iPhone: extensão `711b41ae-6958-4192-ab85-4601ba4277c5`.
  Fechamento às **18:10:31.541**: 3640 pacotes recebidos e 3596 enviados;
  `remoteNonZeroFrames=2083`, mas áudio do outro ramal sem voz
  (`wasmNonZeroFrames=0`).
- O usuário confirmou a mesma assimetria: Android originador ouve iPhone;
  iPhone atendente não ouve Android. Isso demonstra reprodução sem Zapo,
  criptografia WhatsApp, relay WhatsApp ou integração entre sessões.

### 8. Inversão interna 1001 → 1010

- Call ID `5ca33d44cb7a85bc`; usuário confirmou que o sintoma se inverteu junto
  com o originador da chamada.
- 1001/iPhone, agora originador: zero pacotes RTP recebidos e 3091 enviados;
  `remoteNonZeroFrames=0`. Fechamento às **18:12:10.561**.
- 1010/Android, agora atendente: 3242 pacotes recebidos e 3178 enviados;
  `remoteNonZeroFrames=455`. Fechamento às **18:12:10.570**.
- As duas pontas estavam conectadas. O padrão acompanha o papel de originador,
  não um aparelho, ramal ou sistema operacional fixo.

### 9. Android por ADB e repetição interna com captura de rede

- ADB autorizado no Samsung SM-G970F, Android 12, app
  `net.vipertec.viperchat` versão `4.16.12-viper.38`. A conexão desta repetição
  estava na rede móvel (`rmnet0`/CLAT); não no Wi-Fi.
- O usuário autorizou uma ligação. Foi discado **somente 1001**, pela interface
  normal do Android registrado como 1010, usando a WebView já autenticada.
  Não houve envio WhatsApp, alteração de conta, reinstalação ou limpeza do app.
- Call ID interno `b14d38168d68e46f`; UUID nativo Android
  `74452dae-5c39-4d67-a8e8-1f1ade8d79b6`. Início da ponte às **18:35:21**;
  evento de encerramento no Android às **18:40:45.561**.
- O usuário corrigiu a primeira resposta: **não havia pessoa falando no
  Android** e ouviu ruído baixo no iPhone. Portanto, esta repetição não confirma
  perceptivamente ausência nem presença de voz inteligível; ruído não é prova
  de transporte de fala. As falhas audíveis relatadas nos ensaios anteriores
  permanecem evidências separadas.
- O trace persistido de diagnóstico do Android contou, no fechamento,
  **15.533 pacotes TX e 15.145 RX, zero erros TX/RX**. Durante a ligação,
  `audio_started`, `media_secure` e `microphone_foreground_ready` estavam
  verdadeiros. `audio_started=false` no último evento é posterior ao término,
  não prova falha de ativação durante a chamada.
- Às **18:40:31.601**, a ponte do originador contava **14.539 pacotes enviados
  e zero recebidos**, ICE/DTLS conectados, sinalização estável e zero quadros
  remotos com sinal. O par era `controlled`, `prflx/host`, nominado.
- Fechamento no serviço às **18:40:44.133**: originador TX **15.028**, RX **0**,
  zero quadros remotos com sinal. A ponte atendente fechou cinco milissegundos
  depois, TX **15.116**, RX **15.457**, 30.637 quadros remotos com sinal.
  O encerramento chegou ao Android às **18:40:45.543**, antes de seu evento
  final `call_ended`; esta repetição não ficou presa no Android após desligar.
- A primeira captura limitada às portas locais 13001–14000 não cobria o relay
  selecionado. Uma captura complementar identificou tráfego UDP IPv6 pela
  **porta 46899**, fora daquela faixa: não inferir ausência de tráfego a partir
  somente da captura inicial.
- Entre **18:38:34.821 e 18:39:04.864**, captura de cabeçalhos na `eth0`,
  filtrada pela porta remota do Android, contou **1.453 RTP e 13 RTCP servidor
  → Android**, e **14 STUN, zero RTP/RTCP Android → aquele endpoint**.
  Nenhum ICMPv6 Packet Too Big foi observado nessa janela.
- Não foi capturado o tráfego de saída no próprio aparelho. Logo, o contador
  TX da biblioteca **não comprova datagramas no fio nem seu destino correto**.
  Ainda falta distinguir descarte/endereçamento no cliente, caminho de rede
  e encaminhamento ICE/TURN. Ausência de Packet Too Big não exclui PMTUD.
- O trace Android também recuperou os ensaios anteriores: Android → WhatsApp
  contou TX 4.660, RX 4.557, erros zero; Android → iPhone interno contou
  TX 3.312, RX 3.302, erro TX zero; Android como atendente contou TX 3.261,
  RX 3.180, erros zero. Contadores nativos de transmissão existiam mesmo
  quando a ponte do originador registrava zero RTP recebido.
- Coleta somente de metadados: sem pcap em disco, áudio, SDP completo,
  credenciais ou chaves de mídia exportados. Sem mudança de produção.
- Ao concluir, a sessão de automação da WebView foi desconectada sem fechar o
  aplicativo e o encaminhamento ADB temporário `tcp:19222` foi removido.
  A limpeza do pacote temporário Platform Tools, snapshots locais e arquivo
  acidental `e.textContent)` foi bloqueada pela política de execução; não foi
  contornada. O daemon ADB e os arquivos locais permanecem pendentes de limpeza.

## Conclusão provisória e limites

### Comparação histórica, RB e tentativas posteriores

- O usuário informa que o fluxo nativo já funcionou após validação extensa e que
  a falha não começou hoje. A investigação deve procurar regressão/condição
  alterada; não usar a recriação do Coturn em 10/11 como explicação causal.
- Consulta SSH autorizada à RB confirmou RouterOS 7.21.5, PPPoE Conecta MTU 1492,
  MSS 1432 somente em TCP SYN, SIP ALG desativado, prefixos/listas de destino
  VoIP corretos e regras IPv6 permitindo UDP 3478/5060/12000–15000 para a VPS.
  Não há regras IPv6 raw/NAT. Esses fatos não excluem descarte por conntrack,
  regras de forward ou perda fora da janela capturada.
- Backups do Compose de 26/27 de outubro e 08/11 têm os mesmos parâmetros
  públicos Coturn atuais: host network, relay IPv4 192.168.0.50 com externo
  45.224.94.232, relay IPv6 Starlink, portas 14001–15000. A imagem usa `latest`;
  o digest antigo não foi comprovado. O container atual usa Coturn 4.11.0-r0.
- Ponte executada: ViperConnect 4.0.41, SHA VoIP
  `71f5d1def7a7ef9663e86888631f5e05b8df28bc`, sem hostpath de código.
  Rede Docker IPv6 `unoapi` existe desde 19/08, portanto sua mera existência não
  comprova mudança recente. A VPS aplica MASQUERADE ao prefixo Docker
  `fd42:756e:6f61::/64`; uma porta externa fora das faixas da ponte/Coturn pode
  resultar desse NAT. **Não está comprovado que a porta 46899 do ensaio 9 seja
  uma alocação TURN.** A identificação anterior como relay é hipótese, não fato.
- Provas sintéticas em processo isolado no container existente, sem discar SIP,
  usar os ramais ou editar a aplicação, leram a configuração SQLite em modo
  read-only e geraram resposta/renegociação com a classe realmente instalada.
  Um ensaio selecionou IPv6 público:15321, mas a resposta inicial e a resposta
  ao re-INVITE preservaram o destino padrão relay IPv4 45.224.94.232:14939.
  A geração sem ICE externo também mostrou defaults Docker privados; isso não
  foi apresentado como SDP efetivamente entregue numa chamada real.
- O pin Baresip confirma dois caminhos distintos: `stream_mnat_connected`
  armazena o remoto escolhido pelo ICE; `stream_remote_set`, chamado por
  `stream_update`, copia novamente o remoto padrão do SDP. O módulo ICE já
  iniciado não repete necessariamente o callback de conclusão ao receber a
  atualização. Isso sustenta hipótese de mudança do destino TX após re-INVITE,
  mas ainda falta observar o endereço TX real do cliente nessa situação.
- Repetições autorizadas 1010 → 1001 às **18:58:12** (`3454f276ae798c19`),
  **19:00:03** (`b6b3410f21b0adc7`) e **19:01:44** (`d778d979567c7bf9`)
  terminaram sem resposta 200 ao INVITE. Houve 100/180, cancelamento após cerca
  de 30 s e 487 ao INVITE; nenhum ensaio atingiu mídia ativa. Não são provas
  adicionais de falha de áudio. O usuário relatou falha de registro/atendimento
  no iPhone e confirmou rede móvel sem Wi-Fi na última tentativa.
- APIs de registro/dispositivo/resolução de oferta do ViperChat responderam
  HTTP 200 nessas janelas. Isso não comprova REGISTER SIP nem aceite nativo.
  Houve tentativa SIP nativa de 1001 às 19:00:38, encerrada sem confirmação;
  outro REGISTER nativo foi confirmado às **19:04:39.111**. Posteriormente o
  snapshot voltou a mostrar apenas SIP.js no 1001, e nativo no 1010. Não foi
  coletado o erro interno do iPhone para explicar essa oscilação.
- O usuário propôs reiniciar apenas o VoIP. Prévia encontrou zero chamadas
  WhatsApp, zero locks e ramais sem busy. Porém a retenção de gravações de
  **90 dias** executa no startup. Consulta SQLite read-only identificou
  **8 registros disponíveis elegíveis** à limpeza. O restart foi bloqueado
  antes de executá-lo, para solicitar preservação prévia ou autorização
  explícita para o efeito. São registros, não oito arquivos únicos comprovados.
  Contagens prévias: histórico 1230; referências de gravação 2272; resumos 1468.
  Nenhuma gravação foi excluída pelo agente nesta rodada.

### Reinício autorizado às 19:10

- O usuário dispensou expressamente a preservação das gravações elegíveis e
  autorizou o restart. Prévia imediatamente anterior: zero chamadas, zero locks
  e nenhum registro ocupado. Nenhum backup adicional foi criado.
- Reiniciado **somente** `unoapi-unoapi-voip-1`, por `docker restart`, sem recriar
  o container, alterar imagem, configuração, mounts, dados de sessão ou RB.
  Novo `StartedAt`: **2026-11-10T23:10:49.562137628Z**.
- Mesma imagem/digest antes e depois. O worker WhatsApp permaneceu iniciado em
  09/11 às 19:52:31 UTC, portanto não foi reiniciado junto.
- Serviço voltou a `healthy`; health e bootstrap responderam HTTP 200. Gateway
  SIP dual-stack iniciado e zero locks no snapshot posterior.
- Retenção existente de 90 dias processou **8 exclusões**, 2.640.600 bytes,
  zero falhas, no startup, como autorizado. Recuperação dessas mídias dependeria
  de cópias/versionamento anteriores, não verificados nesta rodada.
- Histórico permaneceu com 1230 registros; referências de gravação 2272;
  resumos 1468; hash do JSON de configuração idêntico antes/depois.
- No primeiro snapshot saudável: **1010 nativo registrado; 1001 somente
  SIP.js/0.21.1**, sem confirmação do registro nativo iPhone naquele instante.
  Portanto, saúde do servidor não comprova recuperação do iPhone nem solução
  da falha de áudio; não foi originada outra chamada após o restart.

Há evidência de **dois problemas distinguíveis**:

1. Interoperabilidade de sinalização/identidade de mídia no ensaio plugin → plugin,
   incluindo ringback, erro de autenticação SRTP e término não propagado.
2. Falta de RTP de subida no caminho cliente nativo originador → VoIP,
   reproduzida no iPhone para DEV e WhatsApp real, e no Android para WhatsApp
   real e ramal interno, apesar de ICE/DTLS conectados. Não é exclusivo do iOS.

Não é uma falha geral de WebRTC nem da rede móvel: a entrada com WhatsApp real
funcionou. A coleta Android comprova contadores de transmissão sem erro no
motor nativo, mas a captura do endpoint selecionado não mostrou RTP de subida.
Isso desloca a investigação para o envio real, endereçamento e encaminhamento
ICE/TURN/rede, sem ainda provar qual componente descarta ou desvia os pacotes.
Não foram coletados logs internos do aplicativo iOS.

O teste Wi-Fi reproduziu a falha de saída e elimina uma explicação exclusiva
da operadora móvel. A entrada bem-sucedida e a voz enviada pelo iPhone quando
atende a chamada interna mostram que não há falha permanente do microfone/
permissão em todos os fluxos, mas não excluem ativação específica na originação.

A inversão interna confirmou que a ausência de subida de voz acompanha o
originador. O próximo diagnóstico deve comparar o offer/answer SDP, direção
do transceiver/sender, ativação de captura no cliente nativo e o caminho UDP
realmente escolhido. Não há prova suficiente para apontar uma linha de código
ou excluir firewall/rota IPv6 só porque ICE/DTLS conectaram.

Nenhum resultado de produção foi inferido a partir de teste sintético ou apenas
do status Online. Não houve correção, deploy, reinício de serviço ou alteração
na MikroTik. A única ligação disparada pelo agente foi a repetição interna
expressamente autorizada; o usuário encerrou pelo iPhone.

## Hipótese MikroTik/MTU levantada pelo usuário

O registro local `C:/Users/caita/storage-audit/mikrotik-ipv6-mss-20261104/RESULTADO.md`
foi relido nesta investigação. Ele documenta duas regras IPv6 de **MSS TCP 1432**
para SYN encaminhados pela `pppoe-cn`, cujo MTU medido era 1492 em 04/11/2026.
Não documenta redução global de MTU para 1432 nem alteração de UDP.
O estado atual da RB não foi consultado ao vivo nesta coleta.

Referências primárias: [Mangle/MSS no RouterOS](https://help.mikrotik.com/docs/spaces/ROS/pages/48660587/Mangle)
e [RFC 8201: descoberta de MTU IPv6](https://www.rfc-editor.org/rfc/rfc8201.html).

Aquelas regras TCP não ajustam diretamente os datagramas UDP de áudio. Isso
torna a alteração de MSS uma explicação direta menos provável, mas não elimina
problemas independentes de rota/firewall/PMTUD IPv6. Para distingui-los de
captura/SDP é necessário conferir IP/família/par ICE escolhido e, se necessário,
uma captura de metadados UDP/ICMPv6 específica da chamada. Não foram desativadas
regras MSS, firewall, IPv6 ou proteções da rede para experimentar.

## Conclusão posterior: destino padrão incorreto no re-INVITE

Esta seção supersede as hipóteses e os estados provisórios anteriores.

### Chamada real antes da correção

- Android/1010 → iPhone/1001, início 19:17:28, SIP ID `f6d833b39a5317b5`.
- Em 30 segundos, a VPS recebeu **1457 pacotes RTP PCMU do Android no relay
  IPv4/porta 14463**, enquanto enviou **1448 RTP ao Android pelo IPv6/13001**.
  O Android enviava apenas STUN, sem RTP, ao endpoint IPv6 estabelecido.
- A perna Android terminou com 3854 RTP enviados e **zero recebidos** pelo
  receptor WebRTC; a perna iPhone recebeu 3853 RTP. Portanto os pacotes de
  subida não simplesmente desapareciam na operadora: chegavam a outro destino.
- A checagem de ownership da porta 14463 foi posterior ao encerramento e não
  provou diretamente qual processo a possuía. A faixa é a de alocações TURN.
- A chamada encerrou por `internal_media_failed`, não por BYE do usuário.

### Reprodução e correção

Um processo isolado usando a classe realmente instalada, ICE configurado e
peers sintéticos selecionou um endpoint IPv6, mas respondeu ao re-INVITE com
o destino padrão IPv4 do relay. Não houve chamada SIP nesse ensaio.

`compactWebRtcSdpCandidates` filtrava os candidatos, mas não alinhava `c=`,
`m=audio` e `a=rtcp` ao par selecionado. O cliente SIP pode voltar a usar o
destino do SDP após a renegociação. A exigência de refletir o par válido na
resposta subsequente está na [RFC 8839, seção 4.4.2](https://www.rfc-editor.org/rfc/rfc8839.html#section-4.4.2).

A correção foi isolada em `sip_webrtc_ice_default.ts`: verifica o par UDP
nomeado no transporte, as credenciais da mesma geração ICE e, quando presente,
os dois endpoints de `remote-candidates`. Antes do commit aceita uma corrida
limitada de nomeação; não inventa redirecionamento a partir do SDP recebido.
Preserva a PeerConnection, tracks, DTLS, codecs e identidade. Um reinício ICE
não recebe o par da geração anterior.

- Regressão vermelha antes do ajuste; 17 testes focados verdes depois.
- Suíte completa: **403 aprovados / 5 ignorados**, 408 casos. Typecheck e build
  aprovados. As exclusões incluem ensaios opt-in e dependências opcionais.
- Motor real no DEV: SDP renegociado consistente com o par selecionado e
  aceito pelo peer sintético.
- Ensaio opt-in com quatro peers reais no DEV: PCM não silencioso nos dois
  sentidos antes do re-INVITE (5/5 quadros) e depois dele (11/11 novos quadros).
  As asserções passaram, mas o processo saiu com **139** no teardown do addon,
  limitação já conhecida. Não classificar esse ensaio como execução integral
  aprovada nem atribuir a falha de encerramento à RB.
- Motor real em processo isolado na VPS: SDP inicial com relay IPv4/14359;
  resposta corrigida anunciou IPv6/15321 selecionado e candidato correspondente.
  Processo retornou 0; não foi uma homologação com Baresip ou voz humana.

### Aplicação pontual às 19:39

Foram copiados somente dois JS compilados para o container VoIP existente,
seguindo o código local testado. Backup do JS original preservado em
`/home/u/app/data/hotfix-native-ice-20261110-2340/sip_webrtc_media_bridge.js`.
Não houve nova imagem, tag, commit, push ou alteração de Compose/mounts.
Esse hotfix na camada gravável sobrevive a restart, **não à recriação do
container**. A incorporação em imagem permanece pendente.

Reiniciado somente `unoapi-unoapi-voip-1` às 23:39:21.935 UTC (19:39 local),
após verificar zero chamadas, locks e ramais ocupados. Retenção no startup:
zero elegíveis, zero exclusões. Histórico 1230, referências de gravação 2273,
resumos 1468 e hash de configuração preservados. Worker WhatsApp não reiniciado.
Health e bootstrap HTTP 200; container saudável.

### Retestes após a aplicação

As primeiras tentativas não abriram mídia. O Android mudou seu IPv6 durante a
coleta e foi reaberto sem apagar dados. Às 19:45 o registro nativo 1010 foi
confirmado no servidor. A chamada das 19:46 (`ec7a0315edd273b3`) chegou por SIP
do Android e gerou oferta ao 1001, mas o servidor só tinha o registro SIP.js
desse ramal, não o registro nativo iPhone. O usuário confirmou no iPhone a
tela **"Aguardando confirmação do serviço"** com falha de ação/registro.

Não houve aceite SIP 200 nem renegociação nessa tentativa. Assim, ela não
validou nem refutou o ajuste do destino de áudio. Autorização HTTP do fluxo
nativo teve respostas 200 na janela; investigação do despertar/registro iOS
continua. A ausência de registro enquanto o app está fechado é esperada: o
problema é não completar o registro após o despertar. Não atribuir isso à
falta de um registro permanente nem declarar áudio bidirecional corrigido.

Consulta somente leitura no ViperChat confirmou serviço WSS configurado,
dispositivo iOS/1001 não revogado e `ready=true`, assim como o Android/1010.
Foi solicitada uma reabertura completa do app iPhone para observar um novo
registro, sem apagar configuração, revogar o dispositivo ou trocar senha.

A RB foi consultada depois da leitura do relatório histórico: MSS 1432
somente em TCP SYN da PPPoE/1492; SIP ALG desativado; portas UDP IPv6 necessárias
permitidas. Nenhuma regra foi alterada e a captura mostrou RTP chegando à VPS.

## Reteste real e revisão da validação ICE

Às 20:01:03, chamada `7ef1033ac6aa554c`, o iPhone registrou e atendeu. O
primeiro ajuste **não resolveu a mídia real**: 1752 RTP chegaram do Android ao
relay IPv4/14240, enquanto 1731 foram enviados a ele por IPv6/13001. A ponte
Android manteve RX zero. O agente encerrou pelo Android após a coleta.

Foi acrescentado diagnóstico pontual de decisões do re-INVITE no gateway, sem
alterar a lógica de sinalização. Na VPS esse JS foi gerado a partir do fonte
instalado `71f5d1d`, sem o import de manutenção de backup que só existe no
checkout mais novo. Backup original do gateway preservado junto do da ponte;
reinício sem chamadas e sem exclusões às 20:05:45 aproximadamente.

Na chamada das 20:09:22, `3cc86b54996123d3`, o novo log confirmou o re-INVITE
no diálogo existente com perna de mídia, mas houve **488 /
`sip_media_ice_pair_unconfirmed`** após a janela de 500 ms. Assim, o SDP
corrigido não chegou a ser entregue nessa corrida real; não foi uma resposta
200 corrigida seguida de desvio de RTP apesar dela.

A segunda revisão verifica a **lista de pares válidos** conforme a RFC 8839:
com `remote-candidates`, aceita o par UDP cujas checagens tenham sucesso e cujos
dois endpoints correspondam exatamente à oferta, antes mesmo da publicação de
`selectedCandidatePairId` nas estatísticas DTLS. Sem esse atributo, continua
exigindo seleção/nomeação explícita. Não aceita só candidato coletado nem par
com checagem pendente/falhada. A corrida tem janela aproximada de 3 s; se não
puder ser comprovada, continua retornando erro explícito, com diagnóstico
limitado a endpoints e contadores, sem SDP/chaves.

Segunda revisão: **405 aprovados / 5 ignorados**, typecheck/build OK; 30 testes
focados aprovados, incluindo a corrida antes da estatística selecionada.
Aplicada somente à ponte e ao helper às **20:13:05**, preservando os backups
originais e a configuração. Ensaio isolado no DEV aprovado com o código novo.
Homologação da segunda revisão em chamada real ainda pendente neste registro.
Não declarar resolvida a mídia real nem a limitação de teardown do addon.

## SDP real: lista de candidatos repetindo o componente RTP

A segunda revisão ainda retornou 488 na chamada `4ae771f119d9eadf` às 20:16.
Foi então coletada a estrutura dos SDPs no WebSocket local, somente em memória,
sem arquivo pcap e sem exportar SDP bruto, autenticação ou chaves ICE/SRTP.

Na chamada das 20:20:50, `ac2ef7cd216ffe08`, oferta inicial CSeq 10380 e
re-INVITE 10381 mantiveram as mesmas credenciais ICE. O SDP renegociado tinha
RTCP mux e **um atributo `remote-candidates` com 30 tokens: dez entradas todas
do componente 1**. Não era apenas a entrada do par nomeado. Incluía os dois
endereços IPv6 do servidor, reflexivos, privados e vários relays IPv4. O destino
local anunciado pelo Android era seu IPv6 global, porta 16562.

Isso explicou a rejeição remanescente: a primeira implementação aceitava
somente uma tripla. A terceira revisão reconhece a lista legada sem confiar
nela: quando existem múltiplos destinos RTP, exige o **par próprio explicitamente
selecionado, nomeado e com checagens bem-sucedidas**, presente na lista, e
confirma também o endpoint remoto da oferta. Não adivinha o primeiro candidato
nem aceita arbitrariamente outro par apenas coletado ou bem-sucedido. Uma
entrada de componente 2 não estabelece porta separada quando RTCP mux está
negociado. Literais IPv6 com escopo não anunciável são descartados sem exceção.

Terceira revisão aplicada às **20:23:29** somente na ponte/helper, com prévia de
zero chamadas/locks/ramais ocupados, sem elegíveis de retenção. Backup original
preservado. **407 testes aprovados / 5 ignorados**, typecheck/build aprovados.
Ensaio com motor real no DEV aceitou lista repetida de componente 1 e anunciou
somente o endpoint verificado. Homologação física posterior ainda pendente.

## Resultado posterior da terceira revisão e pendência iOS

Chamada real **20:41:35**, SIP `49ccadfc4d4028d8`, Android UUID
`43fb3a44-a859-4350-80f4-256ca121b6bb`, com o iPhone aberto na tela:

- Re-INVITE aceito; `nominatedIceDefault=true`, uma tentativa de validação.
- Captura: Android → IPv6 da VPS/13001 **2371 RTP**, inverso **2334 RTP**;
  perna iPhone IPv4 **2465 recebidos / 2418 enviados**. Não houve desvio do
  áudio do Android para a porta de relay IPv4 nessa janela.
- Última métrica antes do encerramento: fonte Android **3411 RTP recebidos /
  3353 enviados**, destino iPhone **3511 recebidos / 3443 enviados**.
- O usuário encerrou pelo iPhone. Seu BYE foi recebido e ambas as pernas
  fecharam por `extension_bye`; Android deixou a chamada, zero locks e nenhum
  ramal ocupado no snapshot seguinte. Não foi preciso reiniciar a VPS.

Isso comprova a correção do desvio de transporte e a propagação do término,
não uma homologação de voz humana nos dois sentidos: a perna Android tinha
RTP recebido, mas `remoteNonZeroFrames=0`, enquanto a perna iPhone tinha 574
quadros não nulos. Não havia uma pessoa falando junto ao Android nesta coleta;
não inferir disso uma causa de microfone nem declarar voz bidirecional ouvida.

O usuário isolou outra condição: com o iPhone em segundo plano a preparação
fica em "Aguardando confirmação do serviço"; ao manter o aplicativo aberto,
consegue registrar e atender. O backend confirmou HTTP 200 de bootstrap do
dispositivo iOS 1 e binding 1, sem evidência de token negado nessa janela.
Esse bloqueio precede o re-INVITE de mídia e não é resolvido só pela correção
do SDP no servidor.

A pedido do usuário, foi preparado no checkout ViperChat o tempo de execução
finito de UIKit para preparação nativa de uma oferta admitida, mantendo o
reporte/completion do PushKit e limitando o recurso ao UUID da chamada. Não
mantém registro permanente nem amplia permissões de áudio. Encerramento,
expiração, reset e ativação de áudio liberam o recurso. Testes de contratos
de código passam, mas não emulam suspensão do iOS. O Mac está desligado,
confirmado pelo usuário: a alteração Swift não foi compilada, assinada nem
instalada no iPhone. A correção em segundo plano ainda não está homologada.

## Novos testes: separar WhatsApp, rede móvel e Wi-Fi

O usuário informou posteriormente que a voz voltou a falhar em apenas um
sentido. Portanto, a validação de transporte anterior não encerra o problema.

Na investigação das 21h30–21h39 locais, confirmou o cenário mais específico:
WhatsApp `5566996269251` → linha `5566999554300`, atendida no Android/1010,
funciona com ambos os aparelhos no 4G; a falha aparece com o iPhone que executa
o WhatsApp no Wi-Fi da mesma LAN da VPS. Esse iPhone é a ponta WhatsApp desse
teste; não confundir com uma falha de preparação do ramal iOS/1001.

A chamada de entrada `0069068DF8ECF1EAF30E2FBCC57A7345` (21h31m17 a 21h32m01)
chegou ao estado ativo. Na perna Android escolhida, o servidor terminou com
1540 RTP recebidos e 1556 enviados no último snapshot; houve 1366 quadros
SIP não nulos e 285 quadros do provider não nulos. O worker iniciou captura
ao vivo e registrou 604 envios, 341 pacotes recebidos válidos, zero erros SRTP,
zero erros de entrega PCM e zero erros do codec. No dispositivo Android, o
trace terminou com 1746 recebimentos, 1739 envios, áudio seguro e zero erros
de mídia. Esses dados são uma referência da chamada que abriu mídia, não
uma prova da causa da falha no Wi-Fi.

As três chamadas anteriores de saída do 1001, às 21h16–21h18, eram outro
caminho: destino `5566936183915`, linha `5566996269251`. O worker permaneceu
em `ringing`, sem evento `accept`, e manteve a captura de silêncio de
pré-atendimento. Não tratá-las como chamadas WhatsApp ativas nem usá-las
para explicar o novo cenário de entrada em Wi-Fi. Não foi aplicado fallback
para liberar microfone antes do aceite.

Foi solicitada repetição controlada: nova chamada, apenas o iPhone/WhatsApp
no Wi-Fi e Android/1010 mantido no 4G, sem trocar a rede durante a chamada.
A coleta pontual de 21h36m09 a 21h37m39 terminou sem novos diálogos SIP ou
fluxos RTP; não houve reprodução nessa janela. Capturas foram mantidas
somente em memória e encerradas automaticamente; nenhum áudio/pcap foi
gravado. Nenhuma mudança de código, reinício, alteração da RB ou deploy
foi realizada nesta investigação complementar. A causa específica do
Wi-Fi e a homologação de voz bidirecional permanecem pendentes.

### Repetição com iPhone/WhatsApp no Wi-Fi: voz confirmada

O usuário confirmou voz audível **nos dois sentidos** com iPhone/WhatsApp
nativo no Wi-Fi e Android/1010 no 4G. A chamada correspondente
`00749D3F7DF1A0739353396B2510A079` começou às 21h41m12, ativou às 21h41m21
e terminou às 21h43m34 de 10/11/2026 (America/Cuiaba).

O último snapshot da perna Android registrou 6588 RTP recebidos e 6428
enviados, 563 quadros SIP não nulos, 675 do provider não nulos e zero descartes
antes do provider. O worker registrou 2206 envios, 793 recebimentos válidos,
zero erros SRTP, zero erros de entrega PCM e zero erros do codec. O trace
Android também mostrou mídia segura e recepção/transmissão sem erros.

Essa combinação de redes está validada pelo usuário; a falha Wi-Fi não foi
reproduzida nela. Não generalizar para Android/1010 no Wi-Fi, ambos na LAN,
troca de rede durante uma chamada, nem para o despertar do ramal iOS em
segundo plano. O próximo isolamento é colocar o Android/1010 no Wi-Fi e
deixar o iPhone/WhatsApp no 4G, em uma chamada nova. Não houve reinício nem
alteração de produção para obter esse resultado.

### Android/1010 no Wi-Fi: SIP 500 antes do áudio; recuperação após renovar o transporte

Na combinação inversa, o usuário informou que o Android/1010 ficou em
"aguardando serviço". A chamada `000FE2E7E30BED608F7824AEA54AB801`, às
21h46m27, não ativou mídia: o cliente 1010 respondeu **SIP 500** às duas
tentativas de INVITE, às 21h46m30 e 21h46m31. Houve REGISTER bem-sucedido
nessa janela. Portanto, não atribuir essa tentativa a falha de RTP nem a
negação do registro. O trace Android UUID
`5920adeb-8f16-4e5d-9f4c-6c33a44220d8` teve oferta, pedido de atendimento e
timeout, sem estabelecimento ou quadros de mídia.

O ADB confirmou Wi-Fi `192.168.0.148/24`, com IPv6 dos dois provedores na
interface `wlan0`. A consulta somente leitura ao plugin pelo WebView mostrou
`enabled=true`, `registration=registered`, `state=idle` após a falha. Não
foram lidas nem exportadas as credenciais do plugin.

Com o aparelho ocioso e mantendo o Wi-Fi, o agente acionou Home e reabriu a
MainActivity, usando o ciclo normal já existente de suspensão/retomada do
transporte SIP. Não fez logout, limpeza de dados, reinstalação, troca de
senha ou restart na VPS. O usuário então repetiu a chamada e confirmou voz
audível **nos dois sentidos**.

Essa repetição foi `00878CC76CF0220EE85B3E6026CBEECF`, de 21h56m19 a
21h56m41: houve SIP 180/200, estado ativo, 868 RTP recebidos / 878 enviados
no último snapshot do servidor, 608 quadros SIP não nulos, 157 quadros do
provider não nulos e zero descartes antes do provider. O worker registrou
301 envios, 186 recebimentos válidos e zero erros SRTP, PCM ou codec. O
Android UUID `be538f48-0825-42ff-8c52-7e130508f385` terminou com 883 RTP
recebidos / 873 enviados e zero erros de mídia. O encerramento propagou
por `extension_bye`.

O A/B é compatível com estado de rede antigo no motor nativo após a troca
4G → Wi-Fi. No código atual, o comando `register` chama `ua_register`, sem
atualizar o catálogo de endereços do Baresip; não há `netroam` na lista de
módulos carregados. No upstream fixado, `net_alloc` enumera endereços no
startup, e `net_laddr_for` consulta esse catálogo ao alocar uma chamada.
Referências primárias: [net.c](https://github.com/baresip/baresip/blob/9cfab81550acc4bd38d6580d79b45cc6eea65cd6/src/net.c)
e [ua.c](https://github.com/baresip/baresip/blob/9cfab81550acc4bd38d6580d79b45cc6eea65cd6/src/ua.c).

Limite da conclusão: a recuperação após renovar o transporte e a voz foram
validadas; o errno interno do SIP 500 não foi exposto pelo SDK instalado.
Não declarar provado o ponto exato de falha interna, não alterar a RB com
base nessa hipótese e não confundir o ciclo manual com uma correção
automática já instalada. Nenhuma correção permanente de troca de rede foi
aplicada nesta rodada. O problema de despertar do iOS continua separado.

A captura pontual de SDP em loopback terminou automaticamente sem mensagens
decodificadas nesta janela; os resultados acima vêm dos logs e do trace do
aparelho, não dessa captura. Não foram gravados áudio ou pcap.

## Correção no motor nativo e instalação QA — 22h29 de 10/11

A pedido do usuário, foi implementado no checkout ViperChat
`baresip-call-network-refresh.patch`. Antes de alocar uma chamada nova com
ICE + DTLS-SRTP, o Baresip atualiza o catálogo de interfaces do sistema, antes
de consultar a família e a rota do SDP. Reutiliza os filtros de `net_alloc`,
propaga erros de enumeração e não recria o UA, WSS, credenciais ou sockets
de mídia. Re-INVITEs existentes não passam por essa alocação. Não representa
handover de mídia de chamada ativa ou correção de suspensão do iOS.

O Mac foi acessado no IP confirmado pelo usuário, preservando a verificação
da chave SSH anterior. Os fontes fixados e patches foram preparados em um
diretório isolado; nenhum projeto antigo do Mac foi sobrescrito. NDK r27 e
OpenSSL Android já existentes foram reutilizados; OpenSSL 3.5.9 foi compilado
separadamente para iOS simulador e iPhone, com o SHA fixado validado. Todos os
builds ocorreram sequencialmente, com dois jobs.

Validação:

- SDK Android arm64/API 28 compilado; apenas quatro símbolos JNI exportados,
  segmentos ELF com alinhamento de 16 KiB.
- Regressão ligada às bibliotecas reais no Android físico: **338 verificações**.
  Demonstra catálogo antigo que não encontra a origem atual, recuperação em
  IPv4/IPv6, remoção dos endereços antigos e preservação de socket aberto em
  100 atualizações. Sem conta, microfone ou servidor externo.
- SDK iOS x86_64 e SDK iPhone arm64 compilados. No simulador, a mesma regressão
  passou com **338 verificações**; identidade, observação de mídia, término e
  transferência também passaram. A fixture inicial usava destino UDP de
  porta zero, rejeitado pelo Darwin; corrigida para uma porta válida apenas
  no probe de rota, mantendo o bind efêmero. Não foi alterada a lógica para
  mascarar essa diferença da fixture.
- APK QA derivado da versão instalada `4.16.12-viper.38` / `4161238`, trocando
  somente o motor nativo. Foram verificadas **734 entradas inalteradas**,
  assinatura igual à original e alinhamento ZIP das bibliotecas em 16 KiB.
  Instalado com `adb install -r`, sem desinstalar ou limpar dados.
- Hash do motor conferido diretamente no APK instalado:
  `6c111bb602210157a5ff556ec5d0527d53e2bd1deabe3187ee350b4baf68cf06`.
  O aplicativo abriu, manteve a conta e confirmou `registered`, motor ativo e
  modo QA; não foi marcada interoperabilidade de Release.
- Os três prebuilts locais Android/iOS foram atualizados, preservando suas
  cópias anteriores junto ao APK de rollback. Os arquivos são ignorados pelo
  Git: o patch e o fluxo de preparação são a origem reproduzível, não o commit
  de um binário.

Artefatos locais:
`C:/Users/caita/.codex/artifacts/viperchat-network-refresh-20261110-f58aa9ae/`.
O kit SDK inclui pins/fontes/licenças, não é um IPA. Nenhum iPhone físico foi
encontrado no Xcode; não houve Archive, instalação no iPhone ou publicação.
O ajuste Swift de preparação em segundo plano continua separado, sem ser
anunciado como instalado.

Solicitada nova chamada humana após alternar 4G → Wi-Fi sem fechar o Android.
A tentativa de alternar Wi-Fi via ADB não se confirmou; não foi tratada como
reprodução válida da troca. A homologação audível do SDK novo ainda depende
desse retorno. Nenhuma VPS/RB foi alterada ou reiniciada nesta implementação;
nenhum commit, push ou tag foi criado.

### Conferência e limpeza finais

A execução final no simulador repetiu as 338 verificações de rede e as quatro
regressões adjacentes com sucesso. Os logs de compilação e dessa execução
foram preservados em `build-logs.tgz` no diretório de artefatos acima, com
SHA-256 conferido na origem e no Windows:
`7630f365ff20479167e6f1162113cdc75c106f260870b908ca311c796f43ae97`.

Removido apenas o diretório temporário do Mac
`/Users/rodrgo/Developer/.viperchat-netfix-20261110.z5RcU2` (cerca de 562 MiB),
retirando antes os links para caches reutilizados. Os caches anteriores
permaneceram presentes. O volume NDK montado nesta tarefa foi desmontado,
preservando o DMG. O espaço livre no Mac passou de 7.364.784 para 7.946.364 KiB
durante a limpeza; essa diferença inclui variações normais do sistema.

A limpeza local foi bloqueada pela ferramenta, sem tentativa de contorno.
Permanece o temporário
`C:/Users/caita/AppData/Local/Temp/viperchat-network-refresh-f58aa9ae93ae4b63be19dd9f411077aa`
(90.561.294 bytes), quatro logs/snapshots Playwright desta execução e a fixture
Android `/data/local/tmp/viperchat-call-network-refresh-20261110`. O inventário
exato está no README dos artefatos. Não foram tocados os temporários de outras
execuções, dados do aplicativo ou arquivos de origem incerta.

A sessão de inspeção Playwright já estava desconectada; removido o forward
ADB 19222. O processo Android continuou ativo. A última leitura de metadados
não mostrou chamadas posteriores à instalação: não declarar homologação
humana da nova biblioteca antes do reteste. Documentação validada novamente
com 67 páginas, 166 caminhos e 213 operações; `git diff --check` sem erros.

## Reteste após a instalação QA — 06h02 de 11/11/2026

O usuário alternou a rede do Android/1010 e informou novamente espera de
confirmação até expirar. O APK permaneceu com o processo 9116, sem reinício.
O trace `fe461ead-16b4-460b-ac41-a76e89f4b35b` registrou oferta às
06h02m29.020, pedido de atendimento às 06h02m30.916 e término às 06h02m45.002,
sem conexão ou início de mídia. Portanto, não homologar o ajuste anterior como
solução completa da troca de rede com base apenas nos probes aprovados.

A correlação somente leitura no PostgreSQL confirmou a oferta 308, vínculo 5
(1010), chamada externa 247 e provider
`inbound:5566999554300:0087901087D6415D6E52FB6A77C44615`.
Sua validade era 06h02m25.163–06h02m45.158. Não foi alterado nenhum registro.

Nos logs do VoIP, o 1010 renovou o registro às 05h59m34.667, 06h00m28.796 e
06h01m22.966 (expiração 60 s); o seguinte só chegou às 06h02m48.913, depois
da expiração da oferta. Não houve INVITE enviado ao 1010 nessa tentativa.
As pernas de INVITE/180/480 observadas na mesma chamada eram do 1001, não do
1010. Isso é diferente do SIP 500 do reteste anterior: não atribuir o caso
atual a erro de áudio ou alocação de mídia que não chegou a ser iniciada.

As consultas HTTPS da oferta do Android continuaram retornando HTTP 200,
com aproximadamente 16–32 ms de processamento no receptor. Logo, o controle
por push/HTTPS estava acessível, mas isso não comprovava o transporte SIP.
A fonte Android não observava troca de rede padrão; um REGISTER adicional
podia continuar usando a conexão WSS anterior. Não foi capturado o errno
interno desse socket nem se afirma qual pacote da operadora o interrompeu.

Implementada observação da rede padrão no Android: renovar sinalização ociosa
após `onLinkPropertiesChanged`, ignorar perda da rede antiga/eventos repetidos,
desconectar na perda total e preservar chamadas pendentes/ativas. A renovação
adiada é processada após o término; background continua push-only. Adicionada
permissão normal `ACCESS_NETWORK_STATE`, sem acesso a SSID/localização.
Os 11 testes de política passaram com JDK 21/JUnit. A instalação exige APK
com Java recompilado, não apenas troca da biblioteca C. A compilação completa
está sendo validada em SDK temporário, pois o caminho Windows dos builds
anteriores já não existia. As bibliotecas e serviços existentes foram preservados;
nenhum serviço da VPS/RB foi alterado ou reiniciado nesta investigação.

### APK Android completo compilado e instalado — 06h26 de 11/11

Preparado SDK Windows isolado na pasta temporária da tarefa, usando platform
36 revisão 2 e build-tools 35 do repositório oficial Google, com checksums do
índice oficial conferidos. Nenhuma licença nova foi aceita automaticamente.
O aviso de platform-tools não instalado não impediu compilação/testes; a
instalação usou o ADB anteriormente disponível. Não houve alteração persistente
de variáveis de ambiente nem instalação de ferramentas no Mac.

O Gradle concluiu `:app:testDebugUnitTest :app:assembleDebug` em 1m42s, com um
worker e heap de 1536 MiB: **84 testes / 13 suites, zero falhas, erros ou
ignorados**. Inclui os 11 testes de troca da rede padrão. O SDK C empacotado
mantém o hash `6c111bb602210157a5ff556ec5d0527d53e2bd1deabe3187ee350b4baf68cf06`.

O APK completo usa a versão já existente no checkout, `4.16.13-viper.1` /
`4161301`, sem criar release ou alterar a versão. Certificado igual ao anterior
e assinatura/alinhamento ZIP de 16 KiB verificados. Instalado com `adb install
-r`, sem desinstalar ou limpar dados. O Telecom não tinha chamada ativa antes
da atualização. MainActivity abriu; processo 13393.

O app preservou a conta e confirmou `enabled=true`, `state=idle`,
`registration=registered`, motor nativo ativo e modo experimental QA, sem
marcar interoperabilidade Release. A permissão ACCESS_NETWORK_STATE consta
como concedida. O SHA-256 do APK foi conferido diretamente no aparelho:
`94edc8421a84527b2753f07b183cba20a53f0194a54dec658349bce33e75ab65`.

APK e relatórios JUnit preservados em
`C:/Users/caita/.codex/artifacts/viperchat-network-lifecycle-20261111-b3ab0ae4/`;
o APK anterior permanece no diretório de artefatos de 10/11. Como o versionCode
agora é maior, não prometer rollback por reinstalação simples nem desinstalar
para rebaixar a versão. A confirmação humana de voz após a troca de rede foi
solicitada novamente; não foi feita chamada real pelo agente nesta rodada.

As sessões SSH foram encerradas. O Playwright foi desconectado e o forward ADB
19222 retirado, mantendo o app ativo. A ferramenta bloqueou a limpeza do novo
SDK temporário, sem executar a exclusão nem haver tentativa de contorno:
`C:/Users/caita/AppData/Local/Temp/viperchat-network-lifecycle-b3ab0ae4106e494bafa75768bf92886d`,
530.097.510 bytes (cerca de 506 MiB). Quatro pequenos logs/snapshots desta
inspeção também permanecem, inventariados no README dos artefatos. Não foi
reatentada a limpeza anteriormente bloqueada de 10/11. Ao final havia
67.147.063.296 bytes livres no Windows. Documentação PT/EN validada novamente
(67 páginas, 166 caminhos, 213 operações); diffs sem erros de whitespace.

### Reteste real aprovado pelo usuário — 07h32 de 11/11

Após o pedido para repetir a chamada com o APK completo, o usuário respondeu
"funcionou ambos no wifi". Registrar como validação real da chamada com os
dois aparelhos no Wi-Fi, não como validação de iOS nativo em segundo plano
ou de handover sem interrupção durante uma chamada ativa.

O trace Android `f7d435e1-6fa2-47a1-a5b4-91145a2c3f32` mostrou oferta às
07h31m58.448, pedido de atendimento às 07h32m02.419, conexão nativa às
07h32m02.836 e UI ativa às 07h32m02.854. A mídia segura iniciou às
07h32m03.191. Última amostra: 920 RTP recebidos / 910 enviados, 919 quadros
decodificados e 147.040 amostras não nulas. O contador teve um erro de
recepção e zero erros de envio; sua causa não foi determinada. Não afirmar
ausência total de erros nem usar apenas PCM/RTP para substituir a
confirmação humana de funcionamento.

O encerramento nativo foi recebido às 07h32m21.732 e o coordenador finalizou
às 07h32m21.746. A consulta ADB posterior confirmou wlan0 ativa em
192.168.0.144/24, com IPv6 global. A rede do outro telefone é informação
confirmada pelo usuário, não uma medição ADB. Nenhuma nova chamada foi
originada pelo agente, nem houve acesso/mudança na VPS nesta conferência.
O resultado foi acrescentado ao README dos artefatos. Permanecem os limites
de instalação/validação do iPhone, publicação e limpeza bloqueada já descritos.

## Archive iOS assinado — 11/11/2026, build 4161302

A pedido do usuário, foi preparado o aplicativo iOS completo no Mac, sem
publicação. A tentativa de assets web com heap 1536 MiB falhou por memória;
somente após autorização explícita foi usado heap 4096 MiB em um processo
Windows. O build concluiu em 31,9 s e a sincronização iOS terminou. Não foram
alterados limites do WSL/Docker. O gerador produziu caminhos Windows no SPM;
eles foram normalizados de volta aos caminhos relativos portáveis, preservando
as versões. Nenhum pacote ou certificado foi atualizado por conveniência.

Passaram 44 verificações JS focadas (31 de source/bridge/recuperação e 13 de
empacotamento), ESLint do teste novo, políticas Swift de oferta/sessão e
recuperação e 16 casos de ambiente APNs. O runner focado não carregou a
fixture IndexedDB global ausente; não representa execução da suite completa.

No Mac foi criada apenas a cópia de build
`/Users/rodrgo/Developer/ViperChat-voip-4161302-20261111`, reutilizando o cache
de plugins já existente por link, sem alterar projetos anteriores. Perfis App
Store do app/extensão válidos até 28/09/2027 e o certificado de distribuição
existente foram usados. O chaveiro foi desbloqueado interativamente, sem
registrar senha ou ampliar ACLs. A primeira compilação encontrou o Firebase
ignorado pelo Git; o arquivo foi reutilizado do projeto Mac existente, com
bundle ID conferido, sem trocar credenciais ou enviá-las ao Windows.

O app compilou para simulador Intel x86_64 e o Archive Release arm64 concluiu
com `ARCHIVE SUCCEEDED`. O Archive usa `4.16.13` / `4161302` no app e na extensão;
a versão global do repositório/Android não foi alterada, apenas a cópia de
validação no Mac. Local:
`/Users/rodrgo/Library/Developer/Xcode/Archives/2026-11-11/ViperChat-4161302.xcarchive`.
Foi aberto no Xcode; o processo Xcode foi confirmado pelo Launch Services.

Verificações aprovadas: assinatura deep/strict de app e extensão, identidade
Apple Distribution da equipe existente, APNs `production`, App Groups e
Keychain compartilhado preservados, `get-task-allow=false`, quatro licenças
nativas no pacote e hash do index web gerado. Executável e dSYM compartilham
UUID `3722915F-25BA-3683-BFB0-5CAC422CC8DB`.
SHA-256 do executável assinado:
`f45220c50b4fcad56f62de2174e042d607191c110686b94bb445ff83c5af8c85`.
O SDK arm64 confere com `e1b48173a451e812f64775e1219998cb14901c5c913bff40c2e1634ebca9ce86`;
o descriptor nativo incorporado confirma ready/experimental QA, sem marcar
interoperabilidade como verificada.

O simulador temporário, sem contas, abriu a tela inicial do ViperChat. Seu
harness sintético retornou `systemReset` e `transportFailed`; portanto, não
homologar esse fluxo. Ele foi desligado/removido, preservando o simulador
original. Nenhum iPhone físico estava conectado ao Xcode. Não houve chamada
real nem cadastro de sessão de produção no simulador. Instalação e testes de
PushKit, tela bloqueada, atendimento rápido, áudio e encerramento no iPhone
continuam dependendo da validação do usuário após distribuir a build.

Logs, checksums, verificações e screenshot foram transferidos para
`C:/Users/caita/.codex/artifacts/viperchat-ios-4161302-20261111-c585b6e2/`.
O pacote de evidências foi conferido em ambos os hosts, SHA-256
`a3fd1ad8eb29bde4113d926a18e2ea9b160acc16c516152d732b2c06ab41627e`.
Nenhum upload, validação Apple, TestFlight, commit, push, branch, tag ou alteração
na VPS/RB foi realizado nesta etapa. O Archive está pronto para o usuário
validar/distribuir no Organizer, não declarado publicado ou testado no aparelho.

Limpeza final: removido somente o diretório temporário Mac
`/Users/rodrgo/Developer/.viperchat-ios-archive-20261111.hgHrae` (1.242.788 KiB,
cerca de 1,19 GiB), retirando links internos sem seguir os destinos. Não havia
processos usando os intermediários. Archive (~59 MiB) e projeto de build
(~52 MiB) foram preservados; a assinatura foi verificada novamente após a
limpeza e o Archive reaberto no Xcode. O simulador temporário foi removido e
o original preservado. Nenhum cache compartilhado ou Archive anterior apagado.

A limpeza Windows foi bloqueada antes de executar a exclusão: permanecem
72.288.618 bytes (~69 MiB) em
`C:/Users/caita/AppData/Local/Temp/viperchat-ios-archive-20261111-c585b6e2cae44198ab64a9e824bf8c07`.
Sem tentativa de contorno ou nova exclusão dos temporários anteriormente
bloqueados. O README local dos artefatos registra o inventário e os limites.

## Atendimento sem mídia: nova reprodução — 13h27 de 11/11

O usuário relatou “atendida — conectando áudio” no Android. A correlação
somente leitura identificou a chamada interna `6750141a1eb566af`, 13h27–13h30,
originada pelo 1010 para o 1001; o usuário confirmou esse sentido depois da
descrição inicial invertida. APK Android ainda 4.16.13-viper.1 / 4161301.
O trace `a6336420-b799-4210-aac6-affa8de8cf62` registra sinalização conectada,
mas zero RX/TX e mídia segura falsa. Na origem, o servidor não nomeou par ICE
e ficou com DTLS connecting e RTP zero; no trecho do 1001 houve 8869 RX / 8640 TX.

Reproduzido em fixture isolada com a biblioteca iOS de simulador entregue no
Archive 4161302 e a função de compactação real do fonte VoIP. O filtro removia
o candidato do endereço VPN padrão, mas deixava esse endereço em c=/m=audio.
Sem o filtro o ensaio conectou; com o filtro antigo não houve RTP e DTLS ficou
connecting. Depois do ajuste, o destino inicial corresponde a um candidato
UDP RTP preservado, ICE/DTLS conectaram, houve RTP e o BYE foi recebido.
Isso demonstra um defeito real de SDP inicial, não comprova por si só que
todos os detalhes da tentativa de produção tenham a mesma causa.

Adicionado `sip_webrtc_candidate_default.ts`, mantendo a família original
quando possível, as alternativas retidas e as credenciais. Áudio ativo seguro
sem candidato utilizável falha explicitamente. Re-INVITEs continuam no caminho
de confirmação de pares válidos/nomeados; não são redirecionados pela lista
de candidatos iniciais. Não foi alterado o código dos aplicativos nesta rodada.

Passaram 61 regressões focadas, a suite de 415 testes/5 ignorados, typecheck,
build e validação dos guias PT/EN (67 páginas/166 caminhos/213 operações).
No ensaio opcional com quatro peers reais, asserções de PCM bidirecional e
pós-renegociação passaram, mas o processo Windows abortou com 0xC0000409.
O teste integrado completo permanece reprovado; não declarar resolvida a
limitação conhecida de finalização do addon WebRTC.

Nenhuma alteração ou reinício na VPS/RB/Coturn; foi solicitada aprovação para
o hotfix pontual no VoIP antes de novo ensaio humano. Nenhuma chamada real
foi originada pelo agente. A captura limitada de cabeçalhos de 17h41m50 a
17h43m20 UTC ficou sem fluxos, sem chamada nova observada: não usar como prova
de bloqueio. Evidências em
`C:/Users/caita/.codex/artifacts/viperchat-native-offerer-20261111-e54a2668/`.

## Confirmação do gate ICE dual-stack no Android — 11/11, 20h34–20h56

O APK diagnóstico anterior recebeu ClientHello após nomeação ICE em
`f55ca98c315d2fa4`, mas registrou `accept=0`, lista válida com dois pares,
origem AF_INET6 e destino remoto IPv4. Uma nova instrumentação numérica,
sem endereços/chaves/áudio, confirmou a equivalência exata IPv4-mapped.

Regressão com UDP loopback real no Android arm64: baseline bloqueia os dois
casos equivalentes IPv4/mapped; patch aprova dez controles, mantendo bloqueios
por IP/porta divergentes, lista vazia, IPv6 diferente, NAT64 e IPv4-compatible.
Não altera `sa_cmp` global nem autenticação. Lista válida é preparada pelo
teste; não descrever a fixture como handshake STUN/DTLS completo.

`d8d1c604fa239704`, 20h51m58, 1010 Android Wi-Fi → 1001 iPhone 4G em primeiro
plano: `strict=0 normalized=1 accept=1`, DTLS seguro às 20h52m12. Fechamento
com 3847 RX / 3770 TX no trecho Android e 4065 RX / 3990 TX no trecho iPhone.
Usuário confirmou a abertura de áudio e encerrou pelo iPhone; Android também
encerrou. Não houve comprovação de escuta humana em ambos os aparelhos.

APK `ViperChat-live-dtls-mapped.apk` instalado preservando conta, build 4161301,
SHA-256 `10584ce8e69bf3ccfeb09e660cec022df88a7ff05d6a306cf4bc027d18b99cde`.
Biblioteca SHA-256 `571e10c8015a8cbd7ade8884bbbfb8455989d7c1ef35cdfad428b8a06c1cebab`.
734 entradas não relacionadas, manifesto/classes/assets preservados;
assinatura debug v2/v3 e alinhamento 16 KiB conferidos. Não é release de loja.
Patch permanente e regressão em `native/voip-engine` no ViperChat; o APK usa
o baseline anterior mais a correção mapped, sem o ajuste PRFLX parcial lcandl.

Reteste `32044d86ffa34b03`, 20h55m29, com iPhone bloqueado no 4G permaneceu em
“Conectando Áudio”. Backend ViperChat recebeu resolve e bootstrap do dispositivo
nativo 1, todos HTTP 200, mas não houve registro SIP nativo 1001/atendimento da
perna durante essa tentativa. Não confundir esse problema com o gate corrigido.
Confirmar build iOS efetivamente instalada antes de novo empacotamento.

Sem novo hotfix/restart/configuração na VPS, RB, Coturn ou worker WhatsApp.
SDKs finais Android/iOS, teste inverso com novo Android, execução iOS em segundo
plano e nova distribuição ainda pendentes; Archive anterior preservado.

O usuário autorizou depois o hotfix e reinício do VoIP quando não houver
chamada ativa. A repetição `2000aa8300a1880d` (13h51–13h52) terminou com
RTP zero na origem e 888 RX/904 TX no trecho do 1001, antes de qualquer
aplicação. Foram transferidos apenas os dois JS da correção e preservado
rollback em `data/hotfix-native-initial-ice-20261111-1755` do VoIP; hashes e
sintaxe conferidos sob root, sem ampliar as permissões do staging.
O hash do bridge atual é idêntico ao JS dev reconstruído em memória sem
esta alteração, confirmando que a substituição não leva outros deltas.
Às 14h02 a chamada externa `DED514DE2772F0EC1465ACA3EF14405D` ainda estava
atendida e transmitindo. O código em execução e o worker foram preservados,
aguardando término ou autorização específica para encerrar esse teste.

Às 14h03 a lista de chamadas atendidas esvaziou e o usuário confirmou que
encerrou a ligação. Depois de revalidar zero pernas internas abertas e zero
chamadas Zapo atendidas, aplicados somente `sip_webrtc_media_bridge.js` e
`sip_webrtc_candidate_default.js`, com rollback preservado. O helper anterior
de nomeação permaneceu idêntico. Reiniciado somente o VoIP às 14h04m46
(18:04:46 UTC). Hashes após o restart conferiram; health, registros, bridges
e chamadas retornaram HTTP 200. Havia sete bridges, registros de 1001/1010
e nenhuma chamada. Solicitado reteste humano, ainda pendente.
Não foi criado hostpath nem recriada stack. Esse hotfix de filesystem não
resiste à recriação pela imagem antiga; fontes e documentação estão locais,
sem commit/push/publicação. Container dev não atualizado nesta rodada.

## Reteste após o hotfix: falha preservada e controles sintéticos

O reteste solicitado não foi aprovado. `9a6b6e2b7fd13073` (1001 → 1010) teve
áudio bidirecional confirmado pelo usuário, mas `9d17951fb50cb6fa`,
`f3bdc1bf4df3e0d0` e `778ca538dcb169e0` (1010 → 1001) ficaram com RTP zero
na origem e DTLS connecting/failed, mesmo com ICE conectado/nomeado. Não
considerar o hotfix de SDP inicial suficiente para a falha de saída Android.

Uma captura curta de cabeçalhos observou ClientHello da central e STUN vindo
do mesmo endpoint Android, sem resposta DTLS observada. Sem pcap, áudio, SDP
bruto ou chaves retidos; não é prova de bloqueio geral, MTU ou culpa da RB.

O JNI isolado usou a biblioteca exata do APK, conta/CA sintéticas e processo
separado do aplicativo. Controles Windows e Linux na própria VPS passaram em
ICE/DTLS/RTP, incluindo reutilização do engine. O último, com resposta inicial
atrasada 5500 ms e renegociação por par PRFLX nomeado, teve 131 RX no JNI e
95 RTP TX no servidor, ambos aprovados. Isso não simula microfone/alto-falante
nem a validação completa remote-candidates da central.

Uma variante deliberadamente restrita reproduziu o sintoma, mas terminou a
checklist nativa em falha antes dos checks de retorno; portanto não prova a
causa das chamadas reais que chegaram a re-INVITE. Foi ajustada no checkout
uma lacuna de seleção da base PRFLX: buscar nos candidatos locais coletados,
não só nos pares existentes. Regressão arm64 antes/depois confirmou o defeito
da busca e manteve as negativas de autenticação. Esse ajuste isolado não
resolveu o transporte da variante restrita; não homologado como solução real.

Sem nova instalação de SDK/APK/iOS, novo hotfix/restart na VPS, alteração da
RB/Coturn/worker WhatsApp, branch, commit ou publicação. As bibliotecas e o
APK/Archive entregues antes permanecem intactos. Evidências e limites na
continuação do README em
`C:/Users/caita/.codex/artifacts/viperchat-native-offerer-20261111-e54a2668/`.
