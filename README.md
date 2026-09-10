<div align="center">

# ViperConnect

[![License](https://img.shields.io/badge/license-GPL--3.0-orange)](./LICENSE)
[![Version](https://img.shields.io/badge/version-4.0.30-blue)](https://github.com/ViperTecCorporation/ViperConnect/releases/tag/v4.0.30)
[![Docker](https://img.shields.io/badge/GHCR-viperconnect-blue)](https://github.com/ViperTecCorporation/ViperConnect/pkgs/container/viperconnect)
[![Documentação](https://img.shields.io/badge/docs-viperconnect.vipertec.net-9d3836)](https://viperconnect.vipertec.net/)

Gateway de API para WhatsApp mantido pela ViperTec Corporation.

</div>

## Sobre

ViperConnect é um gateway completo para integrar aplicações ao WhatsApp. Ele foi
criado para operar sessões, enviar e receber mensagens, processar webhooks e
integrar com Chatwoot e Typebot por meio de uma API HTTP estável.

Consulte a [documentação oficial do ViperConnect](https://viperconnect.vipertec.net/)
para instalar, configurar, conectar sessões e explorar todos os endpoints.

O projeto é mantido pela ViperTec Corporation e é baseado no projeto original Unoapi Cloud, criado por Clairton Rodrigo.

## Description

ViperConnect is a complete WhatsApp gateway for session management, messaging,
webhooks, and Chatwoot or Typebot integrations through a stable HTTP API. See
the [official ViperConnect documentation](https://viperconnect.vipertec.net/)
for installation guides and the interactive API reference.

This project is maintained by ViperTec Corporation and is based on the original Unoapi Cloud project created by Clairton Rodrigo.

## Principais recursos

- Manager web para listar, conectar e configurar sessões.
- Envio de mensagens no formato WhatsApp Cloud API.
- Webhooks por sessão, com suporte a múltiplos endpoints.
- Controle para desabilitar um webhook específico sem remover a configuração.
- Integração com Chatwoot e Typebot.
- Redis/Valkey obrigatório para sessões, cache, configurações, IDs e coordenação dos workers.
- RabbitMQ para processamento assíncrono.
- Storage S3 compatível para mídias.
- Normalização PN/LID para reduzir problemas de endereçamento no WhatsApp.
- Embedded Signup do WhatsApp Cloud.

## Início rápido

Escolha o modo de instalação na documentação oficial:

- [Instalação](https://viperconnect.vipertec.net/guide/installation)
- [Docker Compose](https://viperconnect.vipertec.net/guide/docker-compose)
- [Docker Swarm](https://viperconnect.vipertec.net/guide/docker-swarm)
- [Instalador nativo para Linux](https://viperconnect.vipertec.net/guide/install-native-linux)
- [Rede IPv4 e IPv6](https://viperconnect.vipertec.net/guide/network-ipv6)

### Manager

Depois de subir o container, acesse:

```text
https://seu-dominio/
```

ou localmente:

```text
http://localhost:9876/
```

Informe o token configurado em `UNOAPI_AUTH_TOKEN`.

## Exemplo de Envio

```bash
curl -X POST "https://unoapi.seudominio.com.br/v15.0/5566999999999/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: SUA_TOKEN_AQUI" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "55669988887777",
    "type": "text",
    "text": {
      "body": "Olá do ViperConnect"
    }
  }'
```

## Configuração essencial

| Variável | Uso |
| --- | --- |
| `BASE_URL` | URL pública do ViperConnect |
| `UNOAPI_AUTH_TOKEN` | Token de autenticação da API e do manager |
| `AMQP_URL` | Conexão RabbitMQ |
| `REDIS_URL` | Conexão Redis/Valkey |
| `WEBHOOK_URL` | Webhook padrão, opcional |
| `WEBHOOK_TOKEN` | Token enviado ao webhook |
| `WEBHOOK_HEADER` | Header usado para o token do webhook |
| `STORAGE_BUCKET_NAME` | Bucket S3/R2/MinIO |
| `STORAGE_ENDPOINT` | Endpoint S3 compatível |
| `EMBEDDED_SIGNUP_APP_ID` | App ID do Embedded Signup |
| `EMBEDDED_SIGNUP_APP_SECRET` | App Secret do Embedded Signup |

Veja a configuração completa na
[documentação oficial](https://viperconnect.vipertec.net/guide/installation).

## Webhooks

Cada sessão pode ter um ou mais webhooks. Para desabilitar um endpoint específico sem remover a configuração:

```http
PATCH /v19.0/{phone}/webhooks/{webhook_id}
Content-Type: application/json

{ "enabled": false }
```

Para reativar:

```json
{ "enabled": true }
```

Quando `enabled` é omitido, o webhook continua ativo por padrão. Isso preserva compatibilidade com integrações antigas, incluindo providers que não enviam esse campo.

## Documentação

A documentação pública oficial está disponível em:

**[viperconnect.vipertec.net](https://viperconnect.vipertec.net/)**

- [Guias de instalação e configuração](https://viperconnect.vipertec.net/guide/installation)
- [Conexão de sessões](https://viperconnect.vipertec.net/guide/connection)
- [Envio de mensagens](https://viperconnect.vipertec.net/guide/messages)
- [Webhooks](https://viperconnect.vipertec.net/guide/webhooks)
- [Referência interativa da API](https://viperconnect.vipertec.net/api-reference)
- [OpenAPI JSON](https://viperconnect.vipertec.net/openapi.json)

O portal de documentação também pode ser aberto pelo item **Documentação**
no Manager do ViperConnect.

## Desenvolvimento

```bash
yarn install
yarn build
yarn test
```

Executar em desenvolvimento:

```bash
yarn cloud-dev
```

Rodar a versão compilada:

```bash
yarn build
yarn cloud
```

## Imagem Docker

Imagem oficial do projeto ViperConnect:

```text
ghcr.io/viperteccorporation/viperconnect
```

Exemplo:

```bash
docker pull ghcr.io/viperteccorporation/viperconnect:4.0.19
```

A tag `latest` acompanha a versão estável mais recente:

```bash
docker pull ghcr.io/viperteccorporation/viperconnect:latest
```

Nos Composes de produção, não declare `entrypoint` nem `command` para os
containers ViperConnect. Use `UNOAPI_PROCESS_ROLE` (`web`, `broker`, `video` ou
`worker`) para selecionar o processo; a imagem preserva o
Node como PID 1 e executa o desligamento gracioso das sessões Zapo.

## Projetos relacionados e referências técnicas

### Zapo

O runtime de comunicação do ViperConnect utiliza o
[Zapo](https://github.com/vinikjkkj/zapo), com adapters próprios para preservar
o contrato HTTP, os webhooks, os contatos, as mídias e as integrações do
ViperConnect.

As conexões de saída da Zapo permanecem dual-stack. `auto` preserva a seleção
nativa do Node; `ipv6first` e `ipv4first` podem ser aplicados globalmente ou,
de forma independente, ao WebSocket do WhatsApp, upload, download e link
preview, sempre com fallback para a outra família. Consulte
[variáveis de ambiente](docs/ENVIRONMENT.md#zapo-outbound-ip-family).

- [Repositório oficial](https://github.com/vinikjkkj/zapo)
- [Documentação oficial](https://zapo.to/pt-br)

### Meow Caller

A implementação de chamadas utiliza o
[Meow Caller](https://github.com/purpshell/meowcaller) como referência técnica
para partes do fluxo de chamadas 1:1, sinalização, relay direto, RTP/SRTP,
codec e vetores de validação.

O runtime VoIP do ViperConnect é híbrido e possui adaptações próprias; não é
uma cópia pura do Zapo nem do Meow Caller. As diferenças e os pontos de
compatibilidade estão registrados na
[auditoria técnica de VoIP](docs/voip-meowcaller-audit.md).

### Protocolo VoIP do ViperConnect

O áudio 1:1 usa um protocolo próprio e versionado dentro do ViperConnect:

- a Zapo continua sendo dona da sessão, credenciais, Signal, JIDs/LIDs e
  eventos de chamada;
- o Meow Caller fornece referências públicas para o aceite direto, framing,
  RTP/SRTP, SSRC, Allocate STUN e transporte UDP → DTLS → SCTP → DataChannel;
- o vendor `@vipertec/zapo-voip` integra esses contratos ao cliente Zapo e
  acrescenta bridge PCM/SIP, seleção de codec, proteção da perna local,
  recuperação e telemetria segura de relay;
- um `relaylatency` inbound sempre recebe ACK, mas só é devolvido ao peer
  quando o relay possui protocolo suportado, chave e token no offer atual;
- relays WhatsApp IPv4 e IPv6 são mantidos em paralelo com sockets explícitos
  `udp4` e `udp6`; a família do relay é independente da família SIP/RTP do
  ramal e não existe NAT64 de pacotes.

Em 2026-08-21, o caminho foi validado ao vivo em entrada por dados móveis com
RTP remoto pelo IPv6 de um relay autenticado e, em seguida, por Wi-Fi com RTP
remoto pelo IPv4. Os dois canários tiveram áudio bidirecional e zero erro
SRTP/Opus. Essa revisão está validada como hostpatch do worker Zapo; ela só deve
ser descrita como incorporada à imagem após a próxima publicação unificada sem
mounts sobre `dist`.

Consulte também o [runtime VoIP Zapo](docs/voip-zapo-runtime.md) e o
[guia dual-stack](docs-site/guide/voip-ipv6.md).

## Créditos

- Mantenedora: ViperTec Corporation <suporte@vipertec.com.br>
- Rodrigo Caitano <caitano28@gmail.com>
- Baseado no projeto original Unoapi Cloud, criado por Clairton Rodrigo.
- Runtime de comunicação baseado no [Zapo](https://github.com/vinikjkkj/zapo).
- Telefonia baseada no plugin Zapo VoIP, com referências técnicas do
  [Meow Caller](https://github.com/purpshell/meowcaller).

## Aviso legal

Este projeto não é afiliado, autorizado, mantido ou patrocinado pelo WhatsApp, Meta ou qualquer uma de suas afiliadas. WhatsApp e marcas relacionadas pertencem aos seus respectivos proprietários.

O uso de automação em WhatsApp pode violar políticas da plataforma e causar bloqueios. Use por sua conta e risco.

## Licença

Distribuído sob a licença GPL-3.0. Consulte [LICENSE](LICENSE).
