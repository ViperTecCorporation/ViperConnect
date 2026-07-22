<div align="center">

# ViperConnect

[![License](https://img.shields.io/badge/license-GPL--3.0-orange)](./LICENSE)
[![Docker](https://img.shields.io/badge/GHCR-viperconnect-blue)](https://github.com/ViperTecCorporation/ViperConnect/pkgs/container/viperconnect)

Gateway de API para WhatsApp mantido pela ViperTec Corporation.

</div>

## Sobre

ViperConnect é um gateway para WhatsApp baseado em Baileys, com contrato HTTP inspirado na WhatsApp Cloud API. Ele foi criado para operar sessões WhatsApp, enviar mensagens, receber webhooks, integrar com Chatwoot/Typebot e manter compatibilidade com fluxos Meta-like quando necessário.

O projeto é mantido pela ViperTec Corporation e é baseado no projeto original Unoapi Cloud, criado por Clairton Rodrigo.

## Description

ViperConnect is a WhatsApp gateway based on Baileys, exposing an HTTP contract inspired by the WhatsApp Cloud API. It is designed to operate WhatsApp sessions, send messages, receive webhooks, integrate with Chatwoot/Typebot, and preserve compatibility with Meta-like flows when needed.

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

### Docker Compose com Nginx

Use o exemplo em:

```text
docs/examples/docker-compose.unoapi-nginx.yml
```

Ele sobe ViperConnect, RabbitMQ e Valkey, expondo a porta `9876` para o Nginx ou outro proxy reverso.

### Docker Compose com Traefik

Use o exemplo em:

```text
docs/examples/docker-compose.unoapi-traefik.yml
```

Ele usa a network externa `traefik-public` e labels Traefik para publicar o serviço em HTTPS.

### Typebot

Exemplos para publicar Typebot integrado ao ViperConnect:

```text
docs/examples/docker-compose.typebot-nginx.yml
docs/examples/docker-compose.typebot-traefik.yml
```

Guia de configuração: [examples/typebot/README.md](examples/typebot/README.md).

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

Veja a lista completa em [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) e [docs/pt-BR/AMBIENTE.md](docs/pt-BR/AMBIENTE.md).

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

Com o serviço rodando:

- Manager: `/`
- Documentação: `/docs`
- OpenAPI UI: `/docs/openapi.html`
- Swagger UI: `/docs/swagger.html`
- OpenAPI JSON: `/docs/openapi.json`

Arquivos principais:

- [Instalação](docs/INSTALLATION.md)
- [Ambiente](docs/ENVIRONMENT.md)
- [Arquitetura](docs/ARCHITECTURE.md)
- [Desenvolvimento](docs/DEVELOPMENT.md)
- [Embedded Signup](docs/WHATSAPP_EMBEDDED.md)
- [Histórico de mensagens](docs/MESSAGE_HISTORY.md)
- [Migração para o provider Zapo](docs/zapo-provider-migration.md)
- [JIDMAP PN/LID](docs/pt-BR/JIDMAP.md)
- [Status/Broadcast](docs/STATUS_BROADCAST.md)
- [Transcrição de áudio](docs/TRANSCRIPTION_AUDIO.md)

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
docker pull ghcr.io/viperteccorporation/viperconnect:3.0.67
```

## Créditos

- Mantenedora: ViperTec Corporation <suporte@vipertec.com.br>
- Rodrigo Caitano <caitano28@gmail.com>
- Baseado no projeto original Unoapi Cloud, criado por Clairton Rodrigo.
- Baileys: https://github.com/WhiskeySockets/Baileys

## Aviso legal

Este projeto não é afiliado, autorizado, mantido ou patrocinado pelo WhatsApp, Meta ou qualquer uma de suas afiliadas. WhatsApp e marcas relacionadas pertencem aos seus respectivos proprietários.

O uso de automação em WhatsApp pode violar políticas da plataforma e causar bloqueios. Use por sua conta e risco.

## Licença

Distribuído sob a licença GPL-3.0. Consulte [LICENSE](LICENSE).
