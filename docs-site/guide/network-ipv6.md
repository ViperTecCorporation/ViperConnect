# Rede IPv4 e IPv6

Este guia separa três funções que costumam ser confundidas:

| Função | Onde o IPv6 precisa existir |
| --- | --- |
| API e Manager públicos | No host e no proxy Nginx/Traefik que recebe HTTPS |
| Conexões Zapo de saída | No host, na rota padrão e na rede do worker |
| SIP, RTP e relay de chamada | No host da telefonia e nos sockets próprios do VoIP |

Uma instalação pode publicar a API em IPv6 sem entregar um endereço global ao
container. Também pode dar saída IPv6 ao worker sem publicar nenhuma porta dele.

## 1. Validar o host

Antes de alterar Docker ou serviços, confirme endereço global, rota e saída:

```bash
ip -6 address show scope global
ip -6 route show default
sysctl net.ipv6.conf.all.disable_ipv6
ping -6 -c 3 2606:4700:4700::1111
curl -6 --fail-with-body https://cloudflare.com/cdn-cgi/trace
```

O `disable_ipv6` deve ser `0`. Um endereço sem rota padrão não oferece egress.
Não remova ICMPv6: descoberta de vizinhos, MTU e diagnóstico dependem dele.

Use um registro AAAA **DNS-only** para o hostname público. Se o provedor delega
um prefixo dinâmico, atualize o AAAA por DDNS; não grave esse prefixo no código,
na imagem ou no Compose.

## 2. Habilitar uma bridge Docker dual-stack

O modelo principal preserva IPv4 por compatibilidade. Para habilitar IPv6 na
rede `unoapi`, use o override opcional:

- [Baixar override IPv6](/examples/docker-compose.unoapi-ipv6.override.yml)

O arquivo aplica uma rede gerenciada com IPv4 privado e IPv6 ULA:

```yaml
networks:
  unoapi:
    name: unoapi-dualstack
    driver: bridge
    enable_ipv6: true
    ipam:
      config:
        - subnet: 172.23.0.0/16
        - subnet: fd42:756e:6f61::/64
```

`fd42:756e:6f61::/64` é interno e estável; ele não substitui o IPv6 público do
host. No modo bridge padrão, o Docker aplica NAT/masquerade e o tráfego de saída
usa um endereço do host. Ajuste os dois subnets se eles conflitarem com redes da
empresa, VPN ou outro projeto Docker.

Em instalação nova:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  config

docker compose \
  -f docker-compose.yml \
  -f docker-compose.unoapi-ipv6.override.yml \
  up -d
```

Uma rede existente não pode trocar de subnet. Em uma instalação em uso:

1. guarde o Compose atual e confirme os volumes;
2. programe uma janela, pois as sessões reconectarão;
3. valide `docker compose config` com os dois arquivos;
4. execute `docker compose down` **sem** `-v`;
5. suba novamente com os dois arquivos e `--force-recreate`;
6. use os dois arquivos também nos próximos deploys.

Nunca execute `down -v`: essa opção remove volumes persistentes.

Validação:

```bash
docker network inspect unoapi-dualstack
docker exec unoapi-worker-zapo ip -6 address
docker exec unoapi-worker-zapo ip -6 route
docker exec unoapi-worker-zapo node -e \
  "require('node:https').get('https://[2606:4700:4700::1111]',r=>{console.log(r.statusCode);r.resume()}).on('error',e=>{console.error(e.message);process.exit(1)})"
```

Para preferir IPv6 nos canais Zapo, sem torná-lo obrigatório:

```yaml
ZAPO_NETWORK_IP_FAMILY: "ipv6first"
ZAPO_CHAT_SOCKET_IP_FAMILY: ""
ZAPO_MEDIA_UPLOAD_IP_FAMILY: ""
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY: ""
ZAPO_LINK_PREVIEW_IP_FAMILY: ""
```

Se o IPv6 falhar, esses canais tentam IPv4. `PROXY_URL` continua prioritária.

**Mobile Primary:** a conexão de chat usa TCP nativo da Zapo, não WebSocket.
As preferências `ZAPO_CHAT_SOCKET_IP_FAMILY` e a preferência global não injetam
um agente HTTP nesse socket; a seleção de rede do chat permanece nativa.
Upload, download e previews continuam respeitando suas preferências de família.
Isso também vale após restaurar um backup: o transporte é identificado pelas
credenciais armazenadas. Um proxy explicitamente configurado nunca é ignorado;
SOCKS não é suportado pelo transporte TCP mobile da versão atual da Zapo.

## 3. Publicar o container web em IPv6

A arquitetura recomendada é:

```text
cliente IPv4/IPv6 -> DNS A/AAAA -> firewall TCP 443
                   -> Nginx ou Traefik -> unoapi:9876
```

O proxy recebe IPv4 e IPv6, termina TLS e conversa com o container pela rede
interna. O container não precisa receber um endereço IPv6 global.

### Nginx ou Nginx Proxy Manager

No Nginx, mantenha listeners separados e o backend privado:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name unoapi.seudominio.com.br;

    location / {
        proxy_pass http://127.0.0.1:9876;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Se o proxy estiver em container na mesma rede, use `http://unoapi:9876`. Libere
somente `80/tcp` e `443/tcp` no firewall IPv4/IPv6 da borda. A porta 9876 não
precisa ficar pública.

### Publicação direta da porta

Uma publicação sem endereço, como `"9876:9876"`, pode criar bindings no host em
`0.0.0.0` e `[::]`. Porém, o backend HTTP atual do ViperConnect escuta IPv4
dentro do container. O Docker só garante a tradução de um bind IPv6 do host
para o endereço IPv4 do container em uma bridge IPv4-only com
`userland-proxy` ativo. Em uma bridge dual-stack, não presuma que a porta 9876
ficou atendendo IPv6 apenas porque o bind apareceu.

Confira os bindings:

```bash
docker port unoapi 9876
ss -ltnp | grep ':9876\b'
```

Para o backend acessível somente pelo proxy no host, prefira loopback IPv4
explícito e faça o Nginx atender o cliente em `[::]:443`:

```yaml
ports:
  - "127.0.0.1:9876:9876"
```

Não publique a porta 9876 diretamente na Internet quando 443 já é o endpoint
oficial. Esse desenho expõe o serviço web em IPv6 sem depender de bind IPv6 no
Node nem dar um endereço global ao container. O token da API não substitui TLS,
rate limit e regras de borda.

### Traefik

O Traefik deve publicar seu entrypoint `websecure` em 443 no host IPv4/IPv6. A
rede `traefik-public` só precisa ser dual-stack se o trecho Traefik → UnoAPI
também tiver de usar IPv6; para clientes IPv6, basta o entrypoint externo ouvir
em `[::]:443`.

## 4. Linux nativo

No modo nativo não existe bridge Docker. O processo worker usa a rota IPv6 do
próprio host. Depois dos testes da seção 1, configure:

```dotenv
ZAPO_NETWORK_IP_FAMILY=ipv6first
```

Reinicie somente a unit que possui as sessões Zapo e acompanhe a reconexão:

```bash
sudo systemctl restart viperconnect-worker.service
sudo journalctl -u viperconnect-worker.service -f
```

Em instalação de processo único, a unit é `viperconnect.service` e o restart
também interrompe brevemente API e filas.

Para a API pública, restrinja a porta Node 9876 ao host/proxy pelo firewall e
use o mesmo Nginx dual-stack da seção anterior. Valide:

```bash
ss -ltnp | grep -E ':(443|9876)\b'
curl --fail-with-body http://127.0.0.1:9876/ping
curl -6 --fail-with-body https://unoapi.seudominio.com.br/ping
curl -4 --fail-with-body https://unoapi.seudominio.com.br/ping
```

## 5. IPv6 global direto no container

O Docker oferece modo IPv6 `routed`, mas ele exige um `/64` realmente roteado
até o host, rota no gateway e firewall de encaminhamento. Nesse modo não há
NAT66 e o container fica diretamente endereçável. Não use o mesmo prefixo da
LAN por improviso e não copie um prefixo dinâmico para YAML versionado.

Para ViperConnect, esse modo só é indicado quando a operadora delega um prefixo
separado e a equipe controla roteador, NDP/rotas e renovação do prefixo. Para a
maioria das instalações, bridge ULA para egress e proxy no host para ingress é
mais simples e preserva melhor o IPv4 existente.

## 6. Aceite operacional

- `docker network inspect` mostra IPv4 e IPv6 na rede do worker;
- os oito ou mais serviços existentes continuam resolvendo nomes internos;
- `curl -4` e `curl -6` retornam `/ping` pelo domínio público;
- o worker permanece sem reinícios e sem erros DNS/TLS;
- sockets do WhatsApp aparecem em IPv6 quando `ipv6first` está ativo;
- falha controlada de IPv6 mantém envio por fallback IPv4;
- Valkey, RabbitMQ, mídia, webhooks e telefonia continuam saudáveis.

Referências: [IPv6 no Docker Engine](https://docs.docker.com/engine/daemon/ipv6/),
[redes do Docker Compose](https://docs.docker.com/reference/compose-file/networks/)
e [publicação de portas](https://docs.docker.com/engine/network/port-publishing/).
