# Docker Swarm

Os modelos desta página são exclusivos para `docker stack deploy`. Eles não
reutilizam o Compose standalone: usam redes `overlay`, políticas em `deploy`,
DNS interno entre serviços e publicação explícita das portas SIP/RTP/WebRTC.

Use [Docker Compose](/guide/docker-compose) quando todos os containers rodam em
um único host sem Swarm.

## Escolha o proxy

### Nginx ou proxy de borda

Publica `9876/tcp` e `3097/tcp` diretamente no nó marcado como borda. Aponte o
proxy externo para essas duas portas.

<a class="compose-download" href="/examples/docker-stack.unoapi-nginx.yml" download="docker-stack.unoapi-nginx.yml">↓ Baixar stack para Nginx/proxy de borda</a>

### Traefik no Swarm

Conecta a API e a telefonia à overlay externa `traefik-public`. As labels ficam
em `deploy.labels` e usam `traefik.swarm.network`, como exigido pelo provider
Swarm atual.

<a class="compose-download" href="/examples/docker-stack.unoapi-traefik.yml" download="docker-stack.unoapi-traefik.yml">↓ Baixar stack para Traefik</a>

O Traefik deve estar com o provider Swarm habilitado e conectado à mesma rede:

```bash
docker network create --driver overlay --attachable traefik-public
```

Não execute o comando se a rede já existir. Se ela usa outro nome, altere
o nome `traefik-public` no próprio stack antes de validá-lo.

## Configuração dentro do stack

Os dois arquivos para download são completos e autônomos. Imagem, domínios,
URLs internas, armazenamento, tokens, RabbitMQ, Valkey e telefonia ficam no
próprio YAML; não é necessário baixar ou carregar um `.env` separado.

Depois de baixar o modelo escolhido, restrinja as permissões e edite os
placeholders:

```bash
curl -fsSL \
  https://viperconnect.vipertec.net/examples/docker-stack.unoapi-nginx.yml \
  -o docker-stack.unoapi-nginx.yml

chmod 600 docker-stack.unoapi-nginx.yml
nano docker-stack.unoapi-nginx.yml
```

Revise principalmente:

- `BASE_URL`, `VOIP_DOMAIN`, `VOIP_PUBLIC_WS_URL` e os domínios das labels;
- `UNOAPI_AUTH_TOKEN`;
- a mesma senha RabbitMQ em `AMQP_URL` e `RABBITMQ_DEFAULT_PASS`;
- a mesma senha Valkey em `REDIS_URL`, `VALKEY_PASSWORD` e `--requirepass`;
- o mesmo token em `VOIP_SERVICE_TOKEN` e `VOIP_BRIDGE_TOKEN`;
- webhook e armazenamento, quando utilizados;
- IPv4 público, hostname público IPv6 e IP local da telefonia.

O Valkey mantém AOF com fsync a cada segundo e
`no-appendfsync-on-rewrite no`. O RDB fica como snapshot de segurança em `save
3600 1`, substituindo os três intervalos antigos que provocavam regravações
frequentes de todo o dataset. A porta 6379 continua restrita à overlay interna
e protegida por senha.

```bash
openssl rand -hex 32
```

Use valores novos para cada instalação. Os textos `GERE_...`, `TROQUE_...`,
`seudominio.com.br` e o IP reservado `203.0.113.10` são somente marcadores; não
são credenciais nem endereços reais.

A imagem atual consome essas credenciais diretamente por variáveis de ambiente;
ela não implementa variantes `*_FILE`. Portanto, o exemplo não declara Docker
Secrets que o processo não conseguiria ler. Somente administradores do Swarm
devem ter acesso a `docker service inspect` e ao stack já preenchido.

## Preparar os nós

Os volumes do exemplo usam o driver `local`. Valkey e RabbitMQ ficam presos ao
nó marcado como dados; o SQLite e as portas host da telefonia ficam presos ao
nó de VoIP. No modelo Nginx, a API também fica no nó marcado como borda.

```bash
docker node ls

docker node update --label-add viperconnect.data=true NOME_DO_NO_DADOS
docker node update --label-add viperconnect.voip=true NOME_DO_NO_VOIP
docker node update --label-add viperconnect.edge=true NOME_DO_NO_BORDA
```

Um único nó pode receber os três labels. Em cluster com vários nós, faça backup
dos três volumes ou substitua `driver: local` por armazenamento compartilhado
antes de permitir a realocação dos serviços persistentes.

## Portas de mídia fixas e compactas

O Swarm aceita faixas 1:1 na sintaxe curta. O arquivo permanece pequeno e o
`docker stack config` expande internamente cada porta da faixa:

```yaml
- target: 5060
  published: 5060
  protocol: udp
  mode: host
- "12000-13000:12000-13000/udp"
- "13001-14000:13001-14000/udp"
```

Os arquivos para download já contêm todas as entradas expandidas nestas faixas
fixas:

| Uso | Faixa do exemplo |
| --- | --- |
| SIP/RTP | `12000-13000/udp` |
| WebRTC | `13001-14000/udp` |

O stack também fixa os quatro limites no ambiente da telefonia. Dessa forma,
as faixas abertas pelo Swarm e as portas usadas pelo processo permanecem iguais
sem uma etapa de geração durante a instalação.

As portas individuais `3097/tcp` e `5060/udp` continuam em `mode: host`. As
faixas compactas de mídia são expandidas pelo Docker em `mode: ingress`, pois o
formato curto não possui um campo para selecionar o modo. A telefonia permanece
com uma réplica presa ao nó `viperconnect.voip=true`.

O runtime abre sockets IPv4 e IPv6 independentes. Os stacks usam
`SIP_RTP_BIND_IPV4`, `SIP_RTP_BIND_IPV6`, `SIP_RTP_PUBLIC_IPV4` e
`SIP_RTP_PUBLIC_IPV6_HOST`; o último deve ser um hostname DNS-only com AAAA
atualizado, nunca um prefixo dinâmico gravado no YAML. No Swarm, a aplicação
dual-stack não substitui a configuração IPv6 do daemon, das redes e da
publicação de portas do nó. Valide listeners e mídia nas duas famílias conforme
[VoIP dual-stack IPv4 e IPv6](/guide/voip-ipv6).

## Worker dedicado de vídeo

Os stacks incluem `unoapi-video-worker` com `UNOAPI_PROCESS_ROLE=video` e
configuram `UNOAPI_VIDEO_WORKER_MODE=dedicated` no broker. Assim, download por
streaming e FFmpeg não competem com webhooks, status e mensagens comuns.

`video.stage` pode preparar vários downloads conforme o prefetch configurado;
`video.transcode` executa somente uma conversão por instância, com prioridade
baixa. O limite padrão de entrada é 256 MiB e o teto operacional de saída é
256 MiB (`UNOAPI_VIDEO_MAX_OUTPUT_BYTES`), sem compressão adicional.
Não é limite universal do WhatsApp. Se o worker parar, os jobs duráveis aguardam no RabbitMQ; o modo
dedicado não faz failover automático para o broker.

Para manter o desenho antigo sem o serviço separado, remova
`UNOAPI_VIDEO_WORKER_MODE=dedicated` ou use `broker`; nesse modo o próprio
broker consome as duas filas. Não mantenha o modo `dedicated` sem uma réplica
ativa de `unoapi-video-worker`.

## Validar e implantar

Escolha apenas um dos arquivos baixados e já editados:

```bash
STACK_FILE=docker-stack.unoapi-nginx.yml

docker stack config -c "$STACK_FILE" >/dev/null
docker stack deploy \
  --with-registry-auth \
  --resolve-image always \
  -c "$STACK_FILE" \
  viperconnect
```

Para Traefik, use `STACK_FILE=docker-stack.unoapi-traefik.yml`.

Confira a convergência e as portas realmente publicadas:

```bash
docker stack services viperconnect
docker service ps viperconnect_viperconnect-telefonia
docker service logs --tail 100 viperconnect_viperconnect-telefonia
docker service logs --tail 100 viperconnect_unoapi-video-worker
docker service inspect viperconnect_viperconnect-telefonia \
  --format '{{json .Endpoint.Spec.Ports}}'
```

Se um serviço permanecer em `Pending`, confira os labels do nó e a existência
da rede externa do Traefik. O `mode: host` das portas individuais e o label do
nó VoIP garantem uma única tarefa de telefonia naquele host; as duas faixas UDP
compactas são publicadas pelo ingress do Swarm.

## Rede e firewall

| Porta | Protocolo | Publicação |
| --- | --- | --- |
| `9876` | TCP | Somente no modelo Nginx; API e Manager para o proxy de borda. |
| `3097` | TCP | Somente no modelo Nginx; WebSocket e API interna da telefonia para o proxy. |
| `5060` | UDP | SIP tradicional no nó VoIP. O runtime não publica SIP por TCP. |
| `12000-13000` | UDP | Faixa fixa de áudio dos ramais SIP. |
| `13001-14000` | UDP | Faixa fixa de mídia dos clientes WebRTC. |

Libere essas portas para IPv4 e IPv6. Coturn usa adicionalmente `3478/udp`,
`3478/tcp` e uma faixa de relay sem sobreposição, por exemplo
`14001-15000/udp`.

Valkey e RabbitMQ não possuem `ports` e só são acessíveis pela overlay
`unoapi-internal`. No Traefik, `9876` e `3097` também permanecem internos e são
alcançados pelo proxy na overlay externa.

Dentro do cluster, os processos usam os nomes dos serviços:

```bash
AMQP_URL=amqp://...@unoapi-rabbitmq:5672
REDIS_URL=redis://...@unoapi-redis:6379
VOIP_SERVICE_URL=http://viperconnect-telefonia:3097
VOIP_BRIDGE_URL=ws://viperconnect-telefonia:3097/v1/bridge/zapo
```

Não use `network_mode: host`, `container_name`, `depends_on` ou `restart` no
stack. No Swarm, reinício, recursos, placement e labels pertencem a `deploy`.

## Atualização

Com a imagem `ghcr.io/viperteccorporation/viperconnect:latest` declarada no
próprio stack, uma nova implantação resolve novamente a imagem publicada:

```bash
docker stack deploy \
  --with-registry-auth \
  --resolve-image always \
  -c "$STACK_FILE" \
  viperconnect
```

Para uma janela controlada, substitua `latest` pela mesma tag imutável nos
quatro serviços ViperConnect. O serviço VoIP permanece com uma réplica e
atualização `stop-first`, pois mantém SQLite e portas host exclusivas.
