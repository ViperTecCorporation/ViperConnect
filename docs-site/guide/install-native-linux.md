# Instalador Linux oficial

O script `scripts/install-native-linux.sh` instala ou atualiza o ViperConnect
em Debian/Ubuntu. Ele instala Node.js 24 e as dependências de compilação, cria um
usuário de serviço, compila uma tag imutável e só troca a release ativa depois
de todas as validações. FFmpeg e `qpdf` também são instalados; `qpdf` permanece
ocioso e só é chamado para normalizar PDFs Oracle legados detectados no envio.

Valkey/Redis e RabbitMQ são externos e precisam estar acessíveis antes de
iniciar o serviço.

## 1. Baixar a última versão publicada

```bash
LATEST_TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
  https://github.com/ViperTecCorporation/ViperConnect/releases/latest |
  sed 's#.*/tag/##')"

test -n "$LATEST_TAG"

git clone --depth 1 --branch "$LATEST_TAG" \
  https://github.com/ViperTecCorporation/ViperConnect.git
cd ViperConnect
```

`LATEST_TAG` aponta para a release marcada como **Latest** no GitHub. Quando uma
nova release assumir esse canal, uma instalação nova passa a usá-la sem editar
este exemplo.

## 2. Preparar o ambiente

```bash
cp deploy/native/viperconnect.env.example /root/viperconnect.env
nano /root/viperconnect.env
```

Exemplo mínimo:

```dotenv
REDIS_URL=redis://:SENHA_FORTE@127.0.0.1:6379
AMQP_URL=amqp://viperconnect:SENHA_FORTE@127.0.0.1:5672
BASE_URL=https://unoapi.seudominio.com.br
UNOAPI_AUTH_TOKEN=TOKEN_LONGO_E_ALEATORIO
WHATSAPP_ENGINE=zapo
UNOAPI_WORKER_ENGINE=zapo
ZAPO_NETWORK_IP_FAMILY=auto
# Overrides opcionais; vazio herda a política global.
ZAPO_CHAT_SOCKET_IP_FAMILY=
ZAPO_MEDIA_UPLOAD_IP_FAMILY=
ZAPO_MEDIA_DOWNLOAD_IP_FAMILY=
ZAPO_LINK_PREVIEW_IP_FAMILY=
UNOAPI_VIDEO_WORKER_MODE=dedicated
PORT=9876
LOG_LEVEL=info
UNO_LOG_LEVEL=info
BASE_STORE=/var/lib/viperconnect/data
```

`ipv6first` prefere IPv6 no WebSocket, upload/download e link preview, mas
preserva fallback IPv4. Use os overrides quando um canal precisar de ordem
diferente. Se `PROXY_URL` estiver configurada, o proxy continua decidindo DNS e
família de saída.

## Publicar a API nativa em IPv6

No Linux nativo não existe bridge Docker: o worker usa diretamente a rota IPv6
do host. Valide primeiro `ip -6 route`, DNS e `curl -6`. Para a API pública,
termine TLS no Nginx ou Traefik com listeners IPv4 e `[::]:443` e encaminhe para
`127.0.0.1:9876`. Assim, o processo Node permanece protegido como backend e o
proxy controla certificados, limites e firewall.

O procedimento completo, incluindo AAAA DNS-only, exemplo Nginx e testes, está
no [guia de rede IPv4 e IPv6](/guide/network-ipv6).

## 3. Conferir sem alterar o servidor

```bash
bash scripts/install-native-linux.sh \
  --dry-run \
  --tag "$LATEST_TAG" \
  --env-file /root/viperconnect.env
```

O comando mostra tag, papel, diretório da release, diretório persistente e nome
do serviço. No modo `--dry-run`, nada é instalado.

## 4. Instalar

Para a maioria dos ambientes, use um processo único:

```bash
sudo bash scripts/install-native-linux.sh \
  --tag "$LATEST_TAG" \
  --env-file /root/viperconnect.env
```

Sem `--role`, o serviço `viperconnect.service` executa HTTP, filas e sessões.

Em instalações maiores, os papéis podem ser separados:

```bash
sudo bash scripts/install-native-linux.sh \
  --tag "$LATEST_TAG" --role web \
  --env-file /root/viperconnect.env

sudo bash scripts/install-native-linux.sh \
  --tag "$LATEST_TAG" --role broker

sudo bash scripts/install-native-linux.sh \
  --tag "$LATEST_TAG" --role video

sudo bash scripts/install-native-linux.sh \
  --tag "$LATEST_TAG" --role worker
```

Isso cria `viperconnect-web.service`, `viperconnect-broker.service`,
`viperconnect-video.service` e `viperconnect-worker.service`. As quatro units compartilham o mesmo ambiente,
estado e release.

O papel `video` existe para não deixar FFmpeg competir com webhooks e status no
broker. Um vídeo real de 106,9 MB ocupou um núcleo por cerca de 3min30s durante
a conversão. Com `UNOAPI_VIDEO_WORKER_MODE=dedicated`, somente a unit de vídeo
consome as filas `video.stage` e `video.transcode`, uma conversão por vez e com
prioridade baixa.

Se a unit de vídeo parar, os jobs permanecem duráveis no RabbitMQ até ela
voltar; eles não migram automaticamente ao broker. Removendo a variável ou
usando `broker`, instalações antigas continuam processando vídeo no broker.

O fluxo separa `video.stage` (download por streaming) de `video.transcode`
(FFmpeg). Mensagens comuns continuam nas filas normais e não aguardam a
conversão. Os padrões operacionais são:

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `UNOAPI_VIDEO_STAGE_PREFETCH` | `4` | Downloads preparados em paralelo. |
| `UNOAPI_VIDEO_MAX_INPUT_BYTES` | `268435456` | Limite de entrada de 256 MiB. |
| `UNOAPI_VIDEO_MAX_OUTPUT_BYTES` | `268435456` | Teto operacional Zapo de saída (256 MiB), sem compressão adicional. Substitui TARGET_BYTES. |
| `UNOAPI_VIDEO_STAGE_TIMEOUT_MS` | `300000` | Timeout de download e staging. |
| `UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS` | `420000` | Timeout da conversão FFmpeg. |

Cada processo `video` executa uma conversão por vez. Escale esse papel somente
depois de observar CPU, memória e profundidade das filas no RabbitMQ.

## Estrutura criada

```text
/opt/viperconnect/
  current -> releases/TAG_PUBLICADA
  releases/
    TAG_PUBLICADA/
/var/lib/viperconnect/
  data/
    medias/
    logs/
/etc/viperconnect/
  viperconnect.env
```

O arquivo de ambiente recebe permissão `0600`. O processo executa com o usuário
sem shell `viperconnect`, e o serviço só pode gravar no diretório de estado.

## Atualizar

Baixe ou acesse o checkout da nova tag e execute novamente o mesmo instalador:

```bash
sudo bash scripts/install-native-linux.sh \
  --tag NOVA_TAG \
  --env-file /root/viperconnect.env
```

Releases anteriores permanecem em `/opt/viperconnect/releases`.

## Rollback

```bash
sudo ln -sfn \
  /opt/viperconnect/releases/TAG_ANTERIOR \
  /opt/viperconnect/current.next

sudo mv -Tf \
  /opt/viperconnect/current.next \
  /opt/viperconnect/current

sudo systemctl restart viperconnect.service
```

Se os papéis estiverem separados, reinicie os quatro serviços.

## Diagnóstico

```bash
systemctl status viperconnect.service
journalctl -u viperconnect.service -f
systemctl status viperconnect-video.service
curl http://127.0.0.1:9876/ping
```

O instalador aceita ainda `--no-start`, `--install-root`, `--state-root`,
`--service-user` e `--repo`. Execute `bash scripts/install-native-linux.sh
--help` para consultar todas as opções.
