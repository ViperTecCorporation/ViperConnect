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
