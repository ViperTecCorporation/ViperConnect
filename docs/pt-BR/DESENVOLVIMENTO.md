# Guia de Desenvolvimento

## Dev Local com Docker

- Build e subir serviços de dev:
  - `docker compose up -d --build web worker redis rabbitmq minio`
- Hot‑reload:
  - Código montado em `/app` com `nodemon`.
  - Polling ativado para estabilidade no Windows.
- Debug no VS Code:
  - Inspector: `web` → `9229`, `worker` → `9230`.
  - `.vscode/launch.json` já possui “Attach: web/worker”.

## Scripts Úteis

- `yarn web-dev` / `yarn worker-dev` — serviços com nodemon.
- `yarn build` — compilação TypeScript.
- `yarn test` — testes com Jest.

## Endpoints Comuns

- Health: `GET /ping` → `pong!`
- UI da sessão: `GET /session/{phone}` → QR code + pairing/config via Socket.IO.
- Enviar mensagem: `POST /v15.0/{phone}/messages` (formato Cloud API).
- Validação de contatos (standalone): `POST /{phone}/contacts`.
- Listar grupos em cache: `GET /v15.0/{phone}/groups`.
- Listar participantes do grupo: `GET /v15.0/{phone}/groups/{groupId}/participants`.

## Endpoints de Cache de Grupos

Listar grupos em cache de uma sessão:

```
GET /v15.0/{phone}/groups
```

Listar participantes de um grupo em cache:

```
GET /v15.0/{phone}/groups/{groupId}/participants
```

Notas:
- `groupId` aceita `1203...` ou `1203...@g.us` (normalização interna).
- O payload de participantes retorna `jid` e `name`.
- Para contatos PN, `jid` é retornado só com dígitos (sem `@s.whatsapp.net`).
- `name` é resolvido do cache de contatos com fallback PN/LID.
- Se o grupo não estiver no cache Redis, retorna `404`.

## Menções em Grupo (Texto)

Para `POST /v15.0/{phone}/messages` com `type: "text"` e `to` terminando com `@g.us`:

- `@all` ou `@todos` no `text.body`:
  - define `mentionAll=true` antes de enviar ao Baileys
  - remove apenas o token `@all`/`@todos` do texto final
- `@<telefone_valido>` no `text.body`:
  - preenche automaticamente `mentions[]` (normalizado para `@s.whatsapp.net`)
  - mantém o texto com o telefone no `body`
- Se vierem juntos (`@telefones` + `@all/@todos`), as duas regras são aplicadas.

Exemplos:

```
POST /v15.0/{phone}/messages
{
  "to": "120363012345678@g.us",
  "type": "text",
  "text": { "body": "Aviso @todos" }
}
```

```
POST /v15.0/{phone}/messages
{
  "to": "120363012345678@g.us",
  "type": "text",
  "text": { "body": "Oi @5566996269251 e @5566996222471" }
}
```

```
POST /v15.0/{phone}/messages
{
  "to": "120363012345678@g.us",
  "type": "text",
  "text": { "body": "Oi @5566996269251, @5566996222471 @all" }
}
```

## Payload de Edição de Mensagem

A Unoapi aceita um payload Meta-like `type: "message_edit"` em `POST /v15.0/{phone}/messages`.
Essa é uma extensão Unoapi suportada por Baileys e Zapo; a Cloud API oficial da Meta não expõe esse payload de envio.

Exemplo 1:1:

```
POST /v15.0/{phone}/messages
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "5566996269251",
  "type": "message_edit",
  "context": {
    "message_id": "uno-message-id-original"
  },
  "text": {
    "body": "Texto editado"
  }
}
```

Exemplo em grupo:

```
POST /v15.0/{phone}/messages
{
  "messaging_product": "whatsapp",
  "recipient_type": "group",
  "to": "120363012345678@g.us",
  "type": "message_edit",
  "context": {
    "message_id": "uno-message-id-original"
  },
  "text": {
    "body": "@5566996269251 texto editado"
  },
  "mentions": ["5566996269251"]
}
```

Regras:
- `context.message_id` deve ser o ID Unoapi da mensagem original enviada.
- A Unoapi resolve esse ID para o provider id/key original via DataStore.
- A mensagem original deve ter sido enviada pela conta conectada (`fromMe: true`).
- A Baileys usa `sock.sendMessage(jid, { text, edit: originalMessageKey })`; a Zapo usa `client.message.send(jid, content, { editKey: { id, participant? } })`.
- Em edição de grupo, `to` deve ser o ID do grupo (`@g.us`). Menções seguem a mesma normalização das mensagens de texto em grupo.

## Teste de Status/Broadcast

Exemplo (imagem):

```
POST /v15.0/{phone}/messages
{
  "to": "status@broadcast",
  "type": "image",
  "image": { "link": "https://.../image.png", "caption": "Hello" },
  "statusJidList": ["5511999999999", "5511888888888"]
}
```

Nota:
- Se statusJidList estiver vazio ou nulo e type for image/video, Unoapi preenche via Redis contact-info (unoapi-contact-info:<phone>:*).
- Se a lista continuar vazia, nao faz relay.

Resposta adiciona ao Cloud API:

```
{
  ...,
  "status_skipped": ["5511..."],
  "status_recipients": 123
}
```

## Exemplo de reacao

```
POST /v15.0/{phone}/messages
{
  "to": "5511999999999",
  "type": "reaction",
  "reaction": {
    "message_id": "MESSAGE_ID",
    "emoji": "👍"
  }
}
```

## Exemplo de figurinha

PNG/JPG/GIF sao convertidos automaticamente para WEBP antes do envio.

```
POST /v15.0/{phone}/messages
{
  "to": "5511999999999",
  "type": "sticker",
  "sticker": {
    "link": "https://example.com/sticker.png"
  }
}
```

## Problemas Comuns

- Erro de certificado ao baixar `wait-for` no build:
  - Corrigido em `develop.Dockerfile` (instala `ca-certificates` e usa `curl`).
- `voice-calls-baileys` não encontrado:
  - `vendor/` é copiado antes do `yarn install` (corrigido no `develop.Dockerfile`).
- Breakpoints não param:
  - Ative sourcemaps no TS (`"sourceMap": true`) ou use `ts-node` nos scripts dev.

## Wiki do GitHub (opcional)

- Há um workflow em `.github/workflows/wiki-sync.yml` para sincronizar `docs/` → Wiki.
- Configure o secret do repositório `WIKI_TOKEN` (PAT com `repo` e acesso ao Wiki).
- Ao fazer push na branch principal, arquivos em `docs/` serão publicados na Wiki do repositório.
