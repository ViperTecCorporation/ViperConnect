# Conectar uma sessão

## 1. Escute o Socket.IO antes do registro

O QR Code e o código de pareamento são eventos assíncronos. Conecte em `/ws`,
assine a sessão e somente depois registre.

```js
import { io } from "socket.io-client";

const phone = "5511999999999";
const socket = io("https://api.exemplo.com", {
  path: "/ws",
  transports: ["websocket"],
  auth: { token: process.env.UNOAPI_AUTH_TOKEN }
});

socket.on("connect", () => {
  socket.emit("subscribe_qr", { phone });
});

socket.on("broadcast", (event) => {
  if (event.phone !== phone || event.type !== "qrcode") return;

  if (event.content.startsWith("data:image")) {
    // QR Code ou imagem legível do código de pareamento.
    document.querySelector("#pairing").src = event.content;
  } else {
    // Código de pareamento puro.
    document.querySelector("#pairing-code").textContent = event.content;
  }
});
```

Evento recebido:

```json
{
  "phone": "5511999999999",
  "type": "qrcode",
  "content": "data:image/png;base64,iVBORw0KGgo...",
  "ts": 1785100000000,
  "cached": false
}
```

## 2. Registre por QR Code

```bash
curl -X POST "https://api.exemplo.com/v15.0/5511999999999/register" \
  -H "Authorization: Bearer $UNOAPI_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "zapo",
    "connectionType": "qrcode",
    "zapoWebClientProfile": "default",
    "autoConnect": true,
    "useRedis": true,
    "sendNewMessages": true,
    "webhooks": [{
      "id": "principal",
      "url": "https://app.exemplo.com/webhooks/whatsapp",
      "token": "segredo-do-webhook",
      "header": "Authorization"
    }]
  }'
```

### Perfil do cliente no QR

Em uma sessão nova por QR, `zapoWebClientProfile` aceita:

- `default`: comportamento atual da Zapo, com UserAgent Web;
- `wa_personal`: exibe **WA Pessoal** no painel e anuncia UserAgent `ANDROID`;
- `wa_business`: exibe **WA Business** e anuncia `SMB_ANDROID`.

Os dois perfis Android também usam `deviceBrowser: android tablet` e
`devicePlatform: e`. A escolha é persistida no Redis junto à configuração da
sessão e reaplicada nos próximos logins. É experimental e não transforma o
transporte Web em Mobile Primary. Perfis Android exigem QR Code; não são aceitos
com código de pareamento. Depois do primeiro registro, o perfil não pode ser
alterado: execute `deregister` e crie um novo vínculo. O override usa contexto
assíncrono por sessão para não alterar conexões `default` do mesmo worker.

## 3. Ou use código de pareamento

Registre com `"connectionType": "pairing_code"` e solicite:

```bash
curl -X POST "https://api.exemplo.com/5511999999999/request_code" \
  -H "Authorization: Bearer $UNOAPI_AUTH_TOKEN"
```

O retorno HTTP contém o código. O mesmo fluxo também publica uma representação
legível no evento `broadcast`.

> Para trocar o método de uma sessão já registrada, execute `deregister` e
> registre novamente. O método fica bloqueado durante o pareamento.

## 4. Confirme o estado

```bash
curl -H "Authorization: Bearer $UNOAPI_AUTH_TOKEN" \
  "https://api.exemplo.com/sessions"
```

Considere a sessão pronta para envio somente quando o estado indicar conexão
ativa. Não tente enviar enquanto ela estiver aguardando pareamento.
