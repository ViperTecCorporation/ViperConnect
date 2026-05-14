# ViperConnect com Typebot

Este exemplo mostra como usar o Typebot com o ViperConnect atuando como endpoint compatível com WhatsApp Cloud API.

## Compose prontos

Os exemplos oficiais ficam em:

- [docker-compose.typebot-nginx.yml](../../docs/examples/docker-compose.typebot-nginx.yml)
- [docker-compose.typebot-traefik.yml](../../docs/examples/docker-compose.typebot-traefik.yml)

Use o arquivo Nginx quando o proxy reverso publicar manualmente:

- `typebot-builder` em `http://HOST_DOCKER:3001`
- `typebot-viewer` em `http://HOST_DOCKER:3002`

Use o arquivo Traefik quando o Docker já estiver conectado a uma network externa do Traefik.

## Variáveis principais

No Typebot, a integração WhatsApp deve apontar para o ViperConnect:

```env
WHATSAPP_CLOUD_API_URL=https://unoapi.seudominio.com.br
META_SYSTEM_USER_TOKEN=TOKEN_DA_UNOAPI_OU_META_COMPATIVEL
WHATSAPP_PREVIEW_FROM_PHONE_NUMBER_ID=5566999999999
WHATSAPP_PREVIEW_TEMPLATE_NAME=hello
```

URLs públicas:

```env
NEXTAUTH_URL=https://typebot.seudominio.com.br
TYPEBOT_PUBLIC_ENDPOINT=https://bot.seudominio.com.br
NEXT_PUBLIC_VIEWER_URL=https://bot.seudominio.com.br
```

## Storage S3/R2

Para Cloudflare R2 no Typebot, use o endpoint sem `https://` e habilite SSL separadamente:

```env
S3_ENDPOINT=SEU_ACCOUNT_ID.r2.cloudflarestorage.com
S3_SSL=true
S3_REGION=auto
S3_ACCESS_KEY=SUA_ACCESS_KEY
S3_SECRET_KEY=SUA_SECRET_KEY
S3_BUCKET=typebot
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_CUSTOM_DOMAIN=https://midia.seudominio.com.br
```

Tambem configure CORS no bucket R2 para os domínios do Typebot, por exemplo:

- `https://typebot.seudominio.com.br`
- `https://bot.seudominio.com.br`

Métodos sugeridos:

- `GET`
- `PUT`
- `POST`
- `HEAD`

Headers permitidos:

- `*`

## Configuração no Typebot

No fluxo do Typebot:

1. Acesse **Share > WhatsApp**.
2. Clique em **Add WA Phone Number**.
3. Em **System User Token**, informe o token compatível com o ViperConnect.
4. Em **Phone number ID**, informe o número da sessão sem `+`, por exemplo `5566999999999`.
5. Copie a URL de webhook gerada pelo Typebot.
6. Cadastre essa URL como webhook da sessão no ViperConnect.
7. Ative a integração WhatsApp no Typebot e publique o bot.

## Webhook no ViperConnect

Exemplo de webhook por sessão:

```json
{
  "webhooks": [
    {
      "id": "typebot",
      "urlAbsolute": "https://bot.seudominio.com.br/api/v1/workspaces/WORKSPACE_ID/whatsapp/CREDENTIAL_ID/webhook",
      "token": "Bearer TOKEN_DO_TYPEBOT",
      "header": "Authorization",
      "typebot": true,
      "enabled": true
    }
  ],
  "overrideWebhooks": true
}
```

Para desabilitar temporariamente o webhook do Typebot sem remover a configuração:

```http
PATCH /v19.0/{phone}/webhooks/typebot
Content-Type: application/json

{ "enabled": false }
```

## Listas no Typebot

O Typebot não trabalha com todos os formatos interativos do WhatsApp da mesma forma que a Cloud API oficial. Para listas, use um bloco de texto seguido de um input de botão e mantenha listas pequenas.

As imagens antigas de referência continuam nesta pasta em `prints/`.
