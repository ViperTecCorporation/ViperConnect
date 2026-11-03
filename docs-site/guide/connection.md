# Conectar uma sessão

## Versão do SDK Zapo

A dependência `zapo-js` está fixada em **1.11.0**, com correções de reconexão
e pareamento do SDK. O plugin VoIP próprio em `vendor/zapo-voip` permanece
inalterado; esta atualização não incorpora os novos recursos VoIP do upstream.
A opção de reconstrução forçada de sessão Signal disponível no SDK não é
habilitada automaticamente pela aplicação. A manutenção manual por contato está
descrita em [Recuperar criptografia](./contacts#recuperar-criptografia-de-um-contato).

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
- `wa_business`: exibe **WA Business** e anuncia `SMB_IOS`.

O pessoal preserva Android Tablet e QR `e`. A partir da 4.0.37, o Business
usa iPad (DeviceProps `IPAD`), agente `SMB_IOS`, WebInfo e QR `e` como padrao.
O usuario validou vinculo, mensagens e midia no dev em 14/10/2026, sem o 401
observado com SMB_ANDROID. Isso nao garante todos os aparelhos ou redes.
Versao Web, chaves, historico e porta VoIP 3480 permanecem; nao e Mobile Primary.
Default e pessoal nao mudam. A publicacao nao atualiza a VPS automaticamente.

O perfil e persistido no Redis e reaplicado nos logins, inclusive fora do
contexto assincrono inicial. Perfis pessoal/Business exigem QR, nao codigo de
pareamento. Para trocar um perfil registrado, execute deregister e gere novo
vinculo. Nao remova credenciais de outras sessoes.

## 3. Ou use código de pareamento

### Diagnóstico temporário do perfil Business

Um administrador do servidor pode ativar diagnóstico para **uma única sessão**
Business pelo arquivo `zapo_business_diagnostics.json` ao lado do módulo
compilado `zapo_business_diagnostics.js`, com `phone` (somente dígitos) e
`expiresAt` (ISO UTC, no máximo 30 minutos no futuro). Exige reiniciar o worker;
não altera o perfil pessoal, mas o reinício reconecta suas sessões brevemente.
Por padrão não há diagnóstico. Configuração ausente, inválida ou expirada não
ativa a coleta. Remova o arquivo de ativação ao encerrar o teste.

O log `ZAPO_BUSINESS_DIAGNOSTIC` registra somente enums do registro/login,
etapas de validação da identidade e tipos de nós enviados/recebidos. Não inclui
QR, bytes, chaves, assinaturas, tokens, IDs de mensagens, destinatários ou
conteúdo. Há limite de 200 registros por instância e expiração automática.
Não desativa verificação criptográfica, não reenvia eventos nem modifica o
handshake. Os hooks internos são compatíveis com a Zapo fixada e devem ser
revalidados antes de atualizar a biblioteca. Não substituem validação real.

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
