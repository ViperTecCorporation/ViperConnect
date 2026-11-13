# VoIP dual-stack IPv4 e IPv6

O suporte dual-stack está disponível no serviço VoIP a partir da `v0.1.61` e
na imagem unificada ViperConnect a partir da `v4.0.15`. O IPv6 foi adicionado
em paralelo: o caminho IPv4 anterior permanece ativo e continua anunciando o
IPv4 público configurado.

## Como o runtime funciona

SIP UDP, RTP, media bridge e proxy RTP interno abrem sockets separados por
família na mesma porta lógica:

- `udp4` no endereço de bind IPv4;
- `udp6` no endereço de bind IPv6, com `ipv6Only=true`;
- a família do peer é detectada pelo endereço remoto;
- peers IPv4 recebem SIP e SDP IPv4 como antes;
- peers IPv6 recebem URI SIP com literal entre colchetes e SDP com `IN IP6` e
  `c=IN IP6`.

A seleção LAN/NAT de endereços privados continua exclusiva do IPv4. Ela não é
aplicada a peers IPv6.

## Relay de mídia do WhatsApp

O dual-stack da telefonia e o dual-stack do relay WhatsApp são camadas
independentes. O worker Zapo preserva os endpoints `te2` IPv4 e IPv6 anunciados
no offer e abre um socket explícito da família correspondente para cada
candidato (`udp4` ou `udp6`). O helper nativo termina UDP, DTLS, SCTP e o
DataChannel; depois disso, somente PCM trafega pelo bridge interno.

Por isso, um relay WhatsApp IPv6 pode alimentar um ramal SIP IPv4, e o caminho
inverso também é válido. Não há NAT64 de pacotes de mídia. Uma resposta `452
Xor Relayed Address Mismatch` coloca somente o candidato IPv6 incompatível em
quarentena e preserva os candidatos IPv4 paralelos.

Em 2026-08-21, uma chamada inbound por dados móveis recebeu RTP remoto pelo
IPv6 autenticado de `bsb1c01`; a regressão por Wi-Fi recebeu RTP pelo IPv4 de
`gru2c01`. As duas tiveram áudio bidirecional e zero erro SRTP/Opus. A
validação foi realizada no hostpatch 09 do worker e ainda precisa ser incluída
em uma imagem unificada antes de ser considerada release publicada.

## Configuração

```dotenv
SIP_RTP_ENABLED=true
SIP_RTP_BIND_IPV4=0.0.0.0
SIP_RTP_BIND_IPV6=::
SIP_RTP_PUBLIC_IPV4=203.0.113.10
SIP_RTP_PUBLIC_IPV6_HOST=sip6.seudominio.com.br
SIP_RTP_LAN_IP=192.168.0.50
SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS=
SIP_RTP_PORT=5060
SIP_RTP_MEDIA_PORT_MIN=12000
SIP_RTP_MEDIA_PORT_MAX=13000
SIP_WEBRTC_UDP_PORT_MIN=13001
SIP_WEBRTC_UDP_PORT_MAX=14000
```

`203.0.113.10` é reservado para documentação. Substitua pelo IPv4 público da
instalação. O hostname IPv6 deve possuir um registro AAAA **DNS-only** na
Cloudflare e acompanhar o prefixo delegado atual. Não grave um prefixo IPv6
dinâmico no código, na imagem ou no YAML versionado.

As variáveis `SIP_RTP_BIND_HOST`, `SIP_RTP_PUBLIC_ADVERTISE_IP`,
`SIP_RTP_PUBLIC_IP`, `VOIP_DOMAIN` e `SIP_DOMAIN` continuam aceitas como
compatibilidade IPv4. Configurações novas devem usar as variáveis separadas por
família acima; `SIP_RTP_PUBLIC_IPV4` possui prioridade no IPv4.

`SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS` não muda a seleção IPv4/IPv6. Ela autoriza
somente proxies SIP/SBC identificados por IP público a manter no SDP um relay
RTP IPv4 privado e roteável. O comportamento NAT anterior continua intacto para
qualquer peer não listado. Deixe vazia quando não houver esse desenho.

## Portas nas duas famílias

| Uso | Porta ou faixa | Protocolo |
| --- | --- | --- |
| SIP tradicional | `5060` | UDP |
| RTP tradicional e proxy interno | `12000-13000` | UDP |
| ICE/DTLS/SRTP WebRTC | `13001-14000` | UDP |
| TURN/STUN | `3478` | UDP e TCP |
| Relay TURN do exemplo | `14001-15000` | UDP |

As regras precisam existir nos firewalls IPv4 e IPv6. A faixa TURN deve ser
diferente das faixas RTP e WebRTC.

No Docker Compose, a telefonia e o Coturn usam `network_mode: host`, portanto
os sockets escutam diretamente nas interfaces IPv4 e IPv6 do host. No Linux
nativo, o comportamento é o mesmo. No Swarm, IPv6 também depende de o daemon,
a rede e a publicação de portas do nó VoIP estarem preparados para IPv6; não
considere o stack implantado como prova de dual-stack sem executar as
validações abaixo.

## Coturn

O Coturn deve receber listeners, relays e endereços externos de ambas as
famílias. Como `relay-ip` e `external-ip` exigem um endereço, resolva o hostname
AAAA no início do container em vez de fixar o prefixo:

```dotenv
COTURN_LISTEN_IPV4=0.0.0.0
COTURN_LISTEN_IPV6=::
COTURN_RELAY_IPV4=192.168.0.50
COTURN_EXTERNAL_IPV4=203.0.113.10
COTURN_RELAY_IPV6_HOST=sip6.seudominio.com.br
COTURN_EXTERNAL_IPV6_HOST=sip6.seudominio.com.br
COTURN_MIN_PORT=14001
COTURN_MAX_PORT=15000
```

O processo passa um `--listening-ip` e um `--relay-ip` para cada família. No
IPv4 atrás de NAT, `--external-ip` usa `PUBLICO/LOCAL`; no IPv6 global, o
endereço externo e o relay normalmente são o mesmo AAAA resolvido.

### Atualizador DDNS e Coturn da VPS

O pacote operacional versionado em `deploy/ipv6-ddns` acompanha os prefixos
delegados Starlink e Conecta. A cada ciclo ele testa as duas saídas, atualiza
os registros AAAA DNS-only na Cloudflare e, quando o endereço preferencial
muda, atualiza as variáveis IPv6 do Coturn após validar o Compose e criar um
backup.

O arquivo de credenciais fica somente em
`/etc/vipertec-ddns/cloudflare.env`; o repositório contém apenas um exemplo sem
segredos. Em hosts com Docker instalado via Snap, o unit não pode usar
`NoNewPrivileges=true`, pois o launcher do Snap precisa mudar o perfil da
execução. O serviço continua isolando `/tmp` com `PrivateTmp=true`, mas deve ser
tratado como privilegiado porque possui acesso root ao Docker.

Consulte `deploy/ipv6-ddns/README.md` para instalação, restauração, caminhos e
validação pós-alteração.

## Limites desta entrega

O WebSocket interno worker Zapo → VoIP continua na rede Docker existente. O
egress do worker para o WhatsApp pode preferir IPv4 ou IPv6 separadamente no
WebSocket, upload/download e link preview pelas variáveis `ZAPO_*_IP_FAMILY`.
Essa preferência não altera o relay de mídia de chamada, que aceita endpoints
IPv4 e IPv6 numéricos de forma independente, nem muda a família do WebSocket
interno. Veja [Docker Compose](/guide/docker-compose#família-ip-das-conexões-zapo).

## Validação

### Estado da entrega em 13/11/2026

O código consolidado inclui retomada da mesma chamada por até 60 segundos,
correções de SDP/ICE/TURN e aviso local de reconexão nas duas pontas nativas.
A build QA 4161307 foi instalada no Android e validada/enviada ao App Store
Connect para TestFlight interno. O usuário confirmou o bip no teste real;
isso não homologa automaticamente todas as redes, rotas de áudio ou modos
de atendimento. O aviso é misturado à voz recebida, sem enviá-lo por RTP.

As subseções abaixo registram etapas anteriores do diagnóstico. A central
recebeu hotfix pontual, mas publicar os commits não gera uma imagem nova nem
substitui automaticamente a stack em produção.

### Cliente nativo após alternar 4G e Wi-Fi

Se o ramal registra, mas fica aguardando serviço e responde `SIP 500` ao
INVITE, a falha ocorre antes do áudio. No motor nativo do ViperChat foi
adicionada uma atualização dos endereços locais do sistema antes de preparar
uma nova chamada ICE/DTLS-SRTP. Isso evita selecionar a rota com o catálogo
da rede anterior; um novo REGISTER sozinho não atualiza esse catálogo.

O ajuste exige recompilar e instalar o SDK no aplicativo. Está em validação
em pacote QA Android, não em uma nova versão publicada. Reiniciar o worker
VoIP ou atualizar somente a imagem do ViperConnect não instala esse ajuste.
Não altera credenciais, não força IPv4, não reinicia sockets de chamadas já
abertas e não promete manter áudio durante uma troca de rede na chamada
ativa. O despertar/registro do iOS em segundo plano é uma condição separada.

Há outra falha possível com o mesmo texto na tela: receber a oferta por push,
mas não receber o INVITE SIP antes de ela expirar. Após trocar de rede, um
registro antigo em cache não comprova que o socket WSS ainda funciona. No
Android, o app passa a observar a rede padrão e renovar o transporte quando
ocioso, depois de receber os endereços da nova rede. Não reinicia chamadas
pendentes/ativas e mantém a política push-only em segundo plano. Essa camada
exige recompilar e instalar o APK completo; trocar somente a biblioteca do
SDK não basta. Não é correção na VPS nem garantia de handover de áudio.
Verificar separadamente a chegada do REGISTER, o INVITE e sua resposta;
ausência de INVITE não deve ser diagnosticada como falha de RTP ou SIP 500.

No reteste QA de 11/11/2026, o usuário confirmou o funcionamento da chamada
com o Android nativo e o telefone WhatsApp ambos no Wi-Fi; o trace confirmou
conexão, mídia segura nos dois sentidos e encerramento. Essa aprovação é
limitada ao cenário testado, não ao despertar do iOS em segundo plano nem
a uma troca de rede durante chamada ativa. O ajuste ainda não foi publicado.

Para iOS, foi gerado no Mac um Archive local assinado `4.16.13`, build
`4161302`, com o SDK atualizado e a preparação nativa em segundo plano.
Assinaturas, APNs de produção e grupos compartilhados foram conferidos. O
pacote mantém o modo experimental QA; ainda precisa de validação no iPhone,
inclusive tela bloqueada e áudio. O teste sintético CallKit no simulador não
foi aprovado. Não houve envio ao TestFlight nem publicação automática.

### Atendida, mas sem concluir a conexão de áudio

Um atendimento SIP pode completar sem que ICE/DTLS esteja pronto. O filtro
de candidatos da central não pode remover o endereço padrão do SDP e ainda
anunciá-lo em `c=`, `m=audio` ou `a=rtcp`: isso pode prender o cliente nativo
em “conectando áudio”, mesmo com o ramal registrado.

Nas ofertas/respostas iniciais, a ponte agora mantém esses campos coerentes
com um candidato UDP RTP preservado pelo filtro. Mantém a família original
quando possível, sem eliminar as alternativas IPv4/IPv6, alterar credenciais
ou dispensar ICE/DTLS. Se nenhum candidato utilizável restar, retorna erro
explícito. Re-INVITEs continuam exigindo a confirmação do par conforme abaixo.

Essa correção é no serviço VoIP, sem nova configuração ou recompilação do app.
Foi reproduzida e testada em ambiente isolado com o SDK nativo real e aplicada
como hotfix pontual no VoIP da VPS em 11/11/2026, sem recriar a stack. Ainda
não resolveu o reteste Android/1010 → iPhone/1001 de 11/11: o ICE conectou,
mas DTLS ficou pendente e RTP zerado na origem. Não considerar esse sentido
homologado apenas pelo ajuste de SDP. O hotfix sobrevive
ao restart do container, mas não à recriação a partir da imagem antiga.

No motor nativo, um caminho descoberto por STUN autenticado pode precisar de
uma base local ainda sem par na checklist. O ajuste em desenvolvimento busca
essa base entre os candidatos locais coletados, preservando UDP, componente,
família e autenticação. Exige recompilar o SDK; não é uma configuração da RB
nem uma correção já entregue ao aplicativo. Testes de pares não substituem
DTLS, RTP e escuta bidirecional nos aparelhos. O ajuste isolado ainda não
resolveu DTLS no ensaio restrito. Na chamada real, foi identificado outro
descarte no motor Android, descrito a seguir.

### Android recebe os pacotes, mas não conclui DTLS

Um socket UDP IPv6 dual-stack pode entregar um pacote IPv4 como endereço
IPv4-mapped (`::ffff:a.b.c.d`). O motor comparava essa origem com o candidato
IPv4 validado exigindo também a mesma representação de família, descartando
o pacote antes de DTLS apesar de IP e porta idênticos.

O patch nativo em desenvolvimento reconhece somente essa equivalência exata
no filtro ICE, mantendo IP, porta, lista de pares válidos, STUN e fingerprint
DTLS obrigatórios. Não libera outras origens nem equivale NAT64 a IPv4.
Exige recompilar o SDK/aplicativo; uma configuração no painel ou reinício
da central não instala essa correção.

Em 11/11/2026, dez controles UDP reais em loopback passaram no Android. O APK
diagnóstico instalado também concluiu DTLS seguro e RTP nos dois sentidos em
1010/Android Wi-Fi → 1001/iPhone 4G com o app em primeiro plano; o usuário
confirmou a abertura do áudio. Isso não substitui escuta humana nas duas
pontas nem homologa todos os cenários. Não houve nova alteração na VPS/RB.

Com o iPhone bloqueado, um reteste separado permaneceu em “Conectando Áudio”
antes de estabelecer o registro SIP nativo, apesar de oferta/bootstrap HTTP
200. Essa falha de segundo plano continua pendente, assim como o empacotamento
final dos SDKs Android/iOS. O Archive iOS anterior não contém este patch novo.

O usuário confirmou que a falha com a tela bloqueada também ocorre na build
4161302, que já tem a preparação em segundo plano. Foi gerado o Archive QA
4161303 com o patch mapped e diagnóstico numérico de preparação/registro;
compilação, assinatura e testes sintéticos passaram. Isso não significa
instalação no iPhone, disponibilidade no TestFlight ou correção do segundo plano.

### Áudio unilateral após a chamada ser atendida

Nos clientes SIP nativos, uma renegociação (`re-INVITE`) não pode voltar a
anunciar o relay IPv4 inicial quando ICE já selecionou outro caminho, como
IPv6. A ponte VoIP passa a alinhar o destino do SDP ao par UDP efetivamente
selecionado, sem trocar DTLS, codecs ou a conexão existente. Só aceita
`remote-candidates` depois de confirmar os dois endpoints na lista de pares
com checagens ICE bem-sucedidas, mesmo antes da publicação da seleção DTLS; em
um reinício de ICE não reutiliza o par antigo.

Se um cliente listar vários candidatos para o mesmo componente RTP, a ponte
exige que o seu próprio transporte confirme o par escolhido; não aceita o
primeiro endereço da lista como destino de áudio.

Esse ajuste não exige nova configuração ou alteração da RB/Coturn. Está no
código em desenvolvimento e em hotfix pontual na VPS de validação; isso não
significa que uma nova imagem já foi publicada. Para homologar, confira RTP
recebido e enviado após a renegociação **e** a escuta nos dois aparelhos. Um
registro Online ou ICE conectado sozinho não comprova áudio bidirecional.

Antes de iniciar, confira o AAAA e se IPv6 está habilitado no host:

```bash
getent ahostsv6 sip6.seudominio.com.br
sysctl net.ipv6.conf.all.disable_ipv6
```

Depois da implantação:

```bash
ss -lunp | grep -E ':(5060|12[0-9]{3}|13[0-9]{3}|3478)\b'
ss -ltnp | grep ':3478\b'
```

O aceite exige listeners `0.0.0.0` e `[::]`, registro e áudio bidirecional de
um ramal IPv4 e de outro IPv6. No teste IPv6, confira `Via` e `Contact` com o
literal entre colchetes quando aplicável e SDP contendo `o=... IN IP6` e
`c=IN IP6`. No teste IPv4, confirme que SDP e endereço anunciado permanecem os
mesmos da instalação anterior.

Veja também [Telefonia Zapo](/guide/telephony),
[Docker Compose](/guide/docker-compose), [Docker Swarm](/guide/docker-swarm) e
[Telefonia em Linux nativo](/guide/install-voip-native-linux).
