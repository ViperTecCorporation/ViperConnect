# Docker Compose

> Estes modelos são para `docker compose` em um único host. Eles usam rede
> bridge e `network_mode: host` na telefonia; não os envie com
> `docker stack deploy`. Para cluster, overlays e portas host-mode explícitas,
> use o guia de [Docker Swarm](/guide/docker-swarm).

Estes são os dois modelos do próprio projeto e usam a imagem
`viperconnect:latest`. Assim, uma nova instalação acompanha automaticamente a
última imagem publicada no canal `latest`. Ambos preservam a arquitetura usada em produção:
web, broker e worker Zapo separados, com Valkey e RabbitMQ persistentes.

Cada tag Git de release no formato `v*` publica duas referências da mesma
imagem: a versão imutável, por exemplo `4.0.19`, e `latest`. Use `latest` para
acompanhar o canal estável automaticamente ou fixe a versão semântica quando
precisar controlar a janela de atualização.

## Proxy Nginx na borda

Use quando o domínio e o TLS já são administrados pelo Nginx Proxy Manager ou
por outro proxy externo.

<a class="compose-download" href="/examples/docker-compose.unoapi-nginx.yml" download="docker-compose.unoapi-nginx.yml">↓ Baixar Compose para Nginx/proxy de borda</a>

```bash
curl -fsSL \
  https://docs.seudominio.com.br/examples/docker-compose.unoapi-nginx.yml \
  -o docker-compose.yml

nano docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
curl http://127.0.0.1:9876/ping
```

Aponte o proxy para `http://HOST_DOCKER:9876`. Se ele estiver na mesma network
Docker, use `http://unoapi:9876`. Não há outro servidor HTTP dentro do stack.

A telefonia precisa de um segundo host no proxy de borda, por exemplo
`voip.seudominio.com -> http://HOST_DOCKER:3097`. Habilite WebSocket e preserve
o upgrade em `/sip/ws` e `/v1/bridge/zapo`. Esse domínio deve ser o mesmo usado
em `VOIP_PUBLIC_WS_URL` e `VOIP_BRIDGE_URL`.

## Traefik

Use quando o Traefik já está conectado à network externa `traefik-public`.

<a class="compose-download" href="/examples/docker-compose.unoapi-traefik.yml" download="docker-compose.unoapi-traefik.yml">↓ Baixar Compose para Traefik</a>

```bash
docker network create traefik-public

curl -fsSL \
  https://docs.seudominio.com.br/examples/docker-compose.unoapi-traefik.yml \
  -o docker-compose.yml

nano docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
```

Se a network já existir, não execute `docker network create`. Ajuste o domínio,
o entrypoint do Traefik e o `certresolver` nas labels para os nomes usados pelo
seu Traefik. Esse `entrypoint` pertence ao roteador Traefik e não é o
`entrypoint` do container ViperConnect.

## Rede Docker IPv4 e IPv6

O IPv6 público da API e o IPv6 de saída do worker são necessidades diferentes.
Para dar IPv6 aos containers da rede interna, use o override dual-stack:

<a class="compose-download" href="/examples/docker-compose.unoapi-ipv6.override.yml" download="docker-compose.unoapi-ipv6.override.yml">↓ Baixar override de rede IPv6</a>

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  config

docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  up -d --force-recreate
```

Uma rede Docker já criada não muda de subnet. Em instalação existente, programe
uma janela para recriar os containers e a rede, sem usar `down -v`; as sessões
reconectam e os volumes permanecem. O prefixo `fd42:756e:6f61::/64` é ULA
interno e não depende do prefixo público do provedor.

Para publicar o Manager/API em IPv6, prefira Nginx ou Traefik ouvindo em
`[::]:443` e encaminhando para a porta 9876. Isso não exige atribuir um IPv6
global diretamente ao container. Veja o procedimento, firewall e validação no
[guia de rede IPv4 e IPv6](/guide/network-ipv6).

## O que alterar antes de subir

Nos dois arquivos, revise:

- `BASE_URL` e domínio;
- `UNOAPI_AUTH_TOKEN`;
- usuário e senha do RabbitMQ em `AMQP_URL` e no serviço;
- senha do Valkey em `REDIS_URL` e no comando do serviço;
- domínio em `VOIP_BRIDGE_URL` e o mesmo segredo em todos os campos de token VoIP;
- `WEBHOOK_URL`, token e header;
- credenciais de armazenamento S3 compatível, caso utilizado.

## Persistência do Valkey

Os modelos usam o perfil validado em produção: AOF ativo com `appendfsync
everysec`, fsync mantido durante regravações (`no-appendfsync-on-rewrite no`) e
um snapshot RDB de segurança quando houver ao menos uma alteração em uma hora
(`save 3600 1`). Isso evita os snapshots completos a cada 60–300 segundos que
geravam escrita excessiva em bases grandes, sem remover a durabilidade do AOF.

`protected-mode no` é usado somente porque o serviço exige senha e não publica
a porta 6379 para o host. Mantenha a mesma senha em `REDIS_URL`,
`--requirepass` e no healthcheck.

## Ambiente completo da telefonia

Os arquivos para download incluem o perfil operacional completo observado na
implantação de produção. Antes de subir, substitua domínios, IPs e segredos.

| Variável | Finalidade |
| --- | --- |
| `VOIP_BRIDGE_URL` | Bridge autenticado do worker Zapo; use `wss://voip.seudominio.com.br/v1/bridge/zapo`. |
| `VOIP_SERVICE_TOKEN` e `VOIP_BRIDGE_TOKEN` | Autenticam API interna e bridge; use o mesmo token longo nos dois campos. |
| `VOIP_MAX_CONCURRENT_CALLS` | Capacidade anunciada por linha Zapo; padrão 2, mínimo 1 e máximo 32. Use o mesmo valor no worker e na telefonia. |
| `VOIP_DOMAIN` | Domínio SIP canônico apresentado aos ramais. |
| `VOIP_PUBLIC_WS_URL` | URL pública `wss://` usada por SIP/WebRTC. |
| `VOIP_LAN_DOMAIN` | IP ou domínio acessível pelos ramais da rede local. |
| `VOIP_STUN_URL` | Descoberta de candidatos de rede WebRTC. |
| `VOIP_TURN_URL`, `VOIP_TURN_USERNAME`, `VOIP_TURN_CREDENTIAL` | Relay autenticado para WebRTC quando a conexão direta falhar. |
| `VOIP_CALL_ENGINE` | Deve permanecer `zapo_native`. |
| `VOIP_NATIVE_LOG_LEVEL` | Nível do motor de chamadas; use `info` normalmente e `debug` somente para diagnóstico. |
| `CALL_HISTORY_STORAGE`, `VOIP_APP_STORAGE`, `VOICE_CONFIG_STORAGE` | Mantêm histórico, estado operacional e configuração no SQLite. |
| `VOIP_SQLITE_PATH` | Banco persistido no volume da telefonia. |
| `SIP_RTP_BIND_IPV4` e `SIP_RTP_BIND_IPV6` | Abrem sockets IPv4 e IPv6 independentes; use `0.0.0.0` e `::`. |
| `SIP_RTP_PUBLIC_IPV4` | IPv4 público literal anunciado para peers IPv4. |
| `SIP_RTP_PUBLIC_IPV6_HOST` | Hostname DNS-only cujo AAAA acompanha o prefixo IPv6 delegado. |
| `SIP_RTP_LAN_IP` | IP anunciado aos ramais da LAN. |
| `SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS` | IPs públicos, separados por vírgula, de proxies SIP/SBC autorizados a anunciar um relay RTP privado no SDP. Deixe vazio sem proxy. |
| `SIP_RTP_PORT` | Porta UDP de sinalização SIP tradicional. |
| `SIP_RTP_MEDIA_PORT_MIN/MAX` | Faixa UDP de áudio RTP tradicional. |
| `SIP_WEBRTC_UDP_PORT_MIN/MAX` | Faixa UDP de mídia WebRTC. |
| `SIP_RTP_CODECS` | Codecs SIP permitidos; o exemplo usa `PCMU,PCMA`. |
| `SIP_REGISTER_EXPIRES_SECONDS` | Intervalo de renovação dos registros SIP/WebRTC. |

`203.0.113.10` é um IP reservado para documentação. Troque por seu IP público
real. Se não houver coturn disponível, deixe as três variáveis TURN vazias em
vez de apontar para um serviço inexistente.

O runtime dual-stack usa sockets separados por família e preserva o caminho
IPv4. Não grave um IPv6 de prefixo dinâmico no Compose: anuncie o hostname de
`SIP_RTP_PUBLIC_IPV6_HOST`. As variáveis antigas permanecem apenas como aliases
de compatibilidade IPv4. Veja configuração, Coturn e testes em
[VoIP dual-stack IPv4 e IPv6](/guide/voip-ipv6).

No bloco compartilhado da Uno, mantenha este trio com o mesmo host e token do
serviço de telefonia:

```yaml
VOIP_SERVICE_URL: "http://host.docker.internal:3097"
VOIP_BRIDGE_URL: "wss://voip.seudominio.com.br/v1/bridge/zapo"
VOIP_SERVICE_TOKEN: "GERE_UM_TOKEN_LONGO_E_ALEATORIO"
```

No serviço `viperconnect-telefonia`, `VOIP_SERVICE_TOKEN` e
`VOIP_BRIDGE_TOKEN` recebem exatamente esse mesmo segredo. Não coloque o token
na URL e não o exponha em configuração do navegador.

No container, `VOIP_AUTO_UPDATE_ENABLED` e
`VOIP_AUTO_UPDATE_APPLY_ENABLED` permanecem `false`: a atualização acontece com
`docker compose pull` da imagem única. Essas opções ficam ativas somente no
pacote Linux nativo, cujo atualizador troca o artefato instalado pelo `systemd`.

O container usa `network_mode: host`; portanto não adicione `ports:` no serviço
de telefonia. Abra no host `3097/tcp`, `5060/udp`, `12000-13000/udp` e
`13001-14000/udp`. STUN/TURN possui portas próprias e só deve ser publicado se
o serviço correspondente estiver realmente instalado.

Essas portas devem estar liberadas nos firewalls IPv4 e IPv6. Como a telefonia
usa rede host, `ss -lunp` deve mostrar listeners em `0.0.0.0` e `[::]` para SIP
e para as portas RTP alocadas.

## Família IP das conexões Zapo

O worker Zapo aceita uma política global e overrides independentes para o
WebSocket do WhatsApp, upload, download e link preview:

```yaml
ZAPO_NETWORK_IP_FAMILY: "auto"
ZAPO_CHAT_SOCKET_IP_FAMILY: ""
ZAPO_MEDIA_UPLOAD_IP_FAMILY: ""
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY: ""
ZAPO_LINK_PREVIEW_IP_FAMILY: ""
```

Os valores aceitos são `auto`, `ipv6first` e `ipv4first`. Um override vazio
herda o valor global. As opções `ipv6first` e `ipv4first` preservam fallback
para a outra família; não são modos exclusivos. Para preferir IPv6 em todos os
canais, altere somente `ZAPO_NETWORK_IP_FAMILY` para `ipv6first`.

`auto` não instala agente adicional e mantém o comportamento anterior. Quando
`PROXY_URL` estiver preenchida, o SOCKS continua prioritário; com `socks5h`, o
DNS e a família de saída são decididos pelo proxy remoto.

## Arquitetura do modelo

Os quatro serviços ViperConnect usam a mesma imagem e o mesmo bloco de ambiente.
`UNOAPI_PROCESS_ROLE` seleciona `web`, `broker`, `video` ou `worker`; somente o worker
declara o motor Zapo. Nenhum serviço substitui o entrypoint oficial da imagem.

Os exemplos atuais configuram `UNOAPI_VIDEO_WORKER_MODE=dedicated` no broker e
incluem `unoapi-video-worker` com duas CPUs, 1 GB e concorrência de conversão
igual a uma. Isso foi adotado porque vídeos grandes mantêm um núcleo ocupado por
minutos; separá-los impede disputa com webhooks e status.

Para instalações antigas sem o novo container, omita
`UNOAPI_VIDEO_WORKER_MODE` ou use `broker`: o broker continuará consumindo as
filas de vídeo. No modo `dedicated`, se o worker parar, os vídeos ficam no
RabbitMQ até sua recuperação; não há fallback automático ao broker.

O fluxo possui duas filas duráveis: `video.stage` baixa a origem por streaming
e `video.transcode` executa FFmpeg com concorrência igual a uma e prioridade
baixa. Vídeos já compatíveis podem ser preparados sem recodificação; os demais
são normalizados antes de retornarem à fila do provider. O limite padrão de
entrada é 256 MiB e o teto operacional de saída é 256 MiB, configurável
por `UNOAPI_VIDEO_MAX_OUTPUT_BYTES`. Não é limite universal do WhatsApp nem alvo
de compressão. Os perfis HD/SD estão no guia de mensagens. A separação não
atrasa mensagens de texto, porque elas continuam nas filas normais.

Não adicione `entrypoint`, `command`, `yarn cloud` ou `yarn start` ao `x-base`
nem aos serviços `unoapi`, `unoapi-broker`, `unoapi-worker-zapo` e
`viperconnect-telefonia`. A imagem inicia `/home/u/app/container-entrypoint.sh`,
que usa `exec node` e permite ao worker receber `SIGTERM`, desconectar as sessões
e liberar as leases antes de reiniciar.

Embora todos usem a mesma imagem/tag, `unoapi-worker-zapo` e
`viperconnect-telefonia` executam aplicações e árvores de dependência separadas.
O primeiro mantém sessão, protocolo e mídia Zapo; o segundo mantém SIP, ramais,
roteamento e gravações. `UNOAPI_PROCESS_ROLE` escolhe o runtime correto sem
sobrescrever o entrypoint oficial.

Modelo correto:

```yaml
x-base: &base
  image: ghcr.io/viperteccorporation/viperconnect:latest
  restart: always

services:
  unoapi-broker:
    <<: *base
    environment:
      UNOAPI_PROCESS_ROLE: broker
      UNOAPI_VIDEO_WORKER_MODE: dedicated

  unoapi-video-worker:
    <<: *base
    environment:
      UNOAPI_PROCESS_ROLE: video
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 1G

  unoapi-worker-zapo:
    <<: *base
    environment:
      UNOAPI_PROCESS_ROLE: worker
      UNOAPI_WORKER_ENGINE: zapo
```

Para atualizar depois, execute `docker compose pull && docker compose up -d`.
Esse comando baixa o novo `latest` publicado pela tag de release. Se o Compose
estiver fixado em uma versão, altere a tag explicitamente antes do `pull`.

Somente a API é publicada. Valkey e RabbitMQ ficam restritos à network interna
e mantêm dados nos volumes `redis` e `rabbitmq`.

Para QR code, pairing code e atualizações de conexão, o proxy precisa aceitar o
upgrade do Socket.IO em `/socket.io/`.

Para implantar com `docker stack deploy`, use os arquivos próprios de
[Docker Swarm](/guide/docker-swarm). Eles não possuem `container_name`,
`depends_on`, rede bridge nem `network_mode: host`.
