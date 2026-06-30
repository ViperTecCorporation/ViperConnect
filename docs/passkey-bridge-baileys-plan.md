# Plano de implementacao: Passkey Bridge para Baileys, Uno e VoIP

## Objetivo

Permitir pareamento de sessoes WhatsApp que exigem passkey, mantendo a Baileys rodando na VPS/docker e delegando a assinatura WebAuthn para o navegador real do operador.

O container nao deve tentar acessar passkey, Windows Hello, iCloud Keychain ou Google Password Manager. A VPS apenas orquestra o desafio e conclui o protocolo Shortcake da Baileys.

## Premissas

- A passkey do WhatsApp pertence ao `rpId` `whatsapp.com`.
- A chamada `navigator.credentials.get()` precisa rodar em contexto permitido para `web.whatsapp.com`.
- A solucao mais confiavel e uma extensao Chrome carregada no navegador real do operador.
- A extensao [w3nder/wa-passkey](https://github.com/w3nder/wa-passkey) deve ser usada como referencia inicial de UX e plumbing do browser.
- Baileys continua responsavel pelo protocolo WhatsApp.
- Uno expõe a ponte HTTP/HTTPS entre Baileys e extensao.
- VoIP deve conseguir consumir o mesmo estado de sessao depois do pareamento, mas nao precisa participar da assinatura WebAuthn.

## Referencia de extensao

Repositorio base: `w3nder/wa-passkey`.

Pontos aproveitaveis:

- extensao MV3 simples;
- `background.js` atua como fetch proxy;
- `content.js` injeta widget em `web.whatsapp.com`;
- `inject.js` roda no contexto da pagina e chama `navigator.credentials.get()`;
- loop de bridge com `GET /pending` e `POST /assertion`;
- botao `Verificar passkey`;
- deteccao de `authenticatorAttachment`:
  - `platform`: passkey neste dispositivo, como Windows Hello ou Touch ID;
  - `cross-platform`: celular/chave fisica, normalmente exige proximidade/Bluetooth.

Alteracao necessaria para Uno:

- trocar o `BASE = "http://127.0.0.1:7799"` por URL configuravel da Uno, por exemplo `https://unoapi.vipertec.net/passkey-bridge`;
- enviar token temporario de pareamento nas chamadas;
- permitir selecionar ou receber automaticamente o `bridgeId`;
- manter compatibilidade opcional com bridge local para testes de desenvolvimento.

## Referencia upstream whatsmeow

PR de referencia: [tulir/whatsmeow#1186](https://github.com/tulir/whatsmeow/pull/1186).

Decisao importante desse PR:

- a biblioteca nao assina passkey automaticamente;
- ao receber `passkey_prologue_request`, ela emite um evento de pedido de passkey;
- a aplicacao chama `SendPasskeyResponse` depois que o navegador/extensao assina;
- ao receber `crsc_continuation`, ela emite um evento com o codigo de confirmacao;
- a aplicacao mostra/confirma esse codigo com o operador;
- somente depois a aplicacao chama `SendPasskeyConfirmation`, que envia `encrypted_pairing_request`.

Esse modelo e melhor para Uno porque preserva o passo humano do Shortcake e evita concluir o pareamento sem o operador comparar o codigo quando o servidor exigir.

## Arquitetura

```text
Baileys no container Uno
  recebe passkey_prologue_request
  grava job pendente no Redis
  aguarda assertion
  completa Shortcake
        |
        v
Uno API publica
  GET pending
  POST assertion
  status da sessao
        |
        v
Extensao Chrome no web.whatsapp.com
  busca job pendente
  chama navigator.credentials.get()
  devolve credential_id + assertion_json
        |
        v
Navegador/OS do operador
  Windows Hello, Google Password Manager, iCloud Keychain ou chave fisica
```

## Fluxo operacional

1. Operador inicia pareamento de uma sessao na Uno.
2. Uno inicia socket Baileys em modo pareamento.
3. Baileys exibe QR normalmente.
4. Operador escaneia QR no celular.
5. Se a conta exigir passkey, WhatsApp envia `passkey_prologue_request`.
6. Baileys cria um `passkeyBridgeId` e grava no Redis:
   - `phone`
   - `sessionId`
   - `requestOptions`
   - `createdAt`
   - `expiresAt`
   - `status=pending`
7. Uno mostra no painel: `Aguardando passkey no navegador`.
8. Extensao Chrome em `web.whatsapp.com` consulta a Uno com token temporario.
9. Extensao recebe `requestOptions`.
10. Extensao chama `navigator.credentials.get({ publicKey })`.
11. Browser/OS solicita confirmacao da passkey.
12. Extensao envia para Uno:
    - `bridgeId`
    - `credential_id`
    - `assertion_json`
13. Uno entrega assertion para Baileys.
14. Baileys envia `passkey_prologue`.
15. Baileys recebe `crsc_continuation`.
16. Baileys gera e emite o codigo Shortcake para comparacao no celular.
17. Uno mostra o codigo ao operador.
18. Operador confirma que o codigo bate, ou a Uno pula a UX se a Baileys informar `skipHandoffUX`.
19. Uno chama a confirmacao final da Baileys.
20. Baileys deriva chave de pareamento, criptografa `PairingRequest` e envia `encrypted_pairing_request`.
21. Pareamento conclui e a sessao passa a operar igual a uma sessao normal.

## Alteracoes na Baileys

### Novos tipos

Arquivo sugerido: `src/Types/Passkey.ts`

```ts
export type PasskeyAssertion = {
  credentialId: Buffer
  assertionJson: Buffer
}

export type PasskeyAuthenticator = {
  getAssertion(requestOptions: Buffer, context: PasskeyAssertionContext): Promise<PasskeyAssertion>
}

export type PasskeyAssertionContext = {
  phone?: string
  bridgeId: string
  timeoutMs: number
}
```

Adicionar em `SocketConfig`:

```ts
passkeyAuthenticator?: PasskeyAuthenticator
passkeyTimeoutMs?: number
```

### Modulo Shortcake

Arquivo sugerido: `src/Utils/passkey-shortcake.ts`

Responsabilidades:

- gerar keypair efemero X25519;
- gerar `companionNonce`;
- montar `CompanionEphemeralIdentity`;
- montar commitment `SHA256(companionEphemeralIdentity || companionNonce)`;
- montar `ProloguePayload`;
- decodificar `PrimaryEphemeralIdentity`;
- derivar codigo de verificacao;
- derivar encryption key com HKDF-SHA256;
- montar `PairingRequest`;
- criptografar `EncryptedPairingRequest` com AES-GCM.

Constantes:

```text
shortcakeNonceLength = 32
shortcakeVerificationCodeLength = 5
shortcakeEncryptionKeyLength = 32
shortcakeGCMIVLength = 12
shortcakeEncryptionKeyInfo = "Pairing Information Encryption Key"
```

### Handler de notificacoes

Arquivo provavel: `src/Socket/messages-recv.ts`

Adicionar tratamento:

- `passkey_prologue_request`
- `crsc_continuation`

Comportamento:

- se `passkeyAuthenticator` nao estiver configurado, logar erro claro e emitir evento;
- se estiver configurado, obter assertion;
- enviar IQ `md/passkey_prologue`;
- manter `shortcakeLinkingState` em memoria durante o pareamento;
- no `crsc_continuation`, enviar `companion_nonce`, calcular codigo e emitir evento de confirmacao;
- enviar `encrypted_pairing_request` somente quando a aplicacao chamar a confirmacao final.

### Eventos

Adicionar eventos na Baileys:

```ts
'passkey.update': {
  phone?: string
  bridgeId?: string
  status: 'request' | 'response-sent' | 'confirmation' | 'completed' | 'timeout' | 'error'
  code?: string
  skipHandoffUX?: boolean
  error?: string
}
```

Esses eventos permitem a Uno atualizar a tela sem acoplar UI dentro da Baileys.

## Alteracoes na Uno

### Redis

Chaves sugeridas:

```text
unoapi:passkey:{bridgeId}
unoapi:passkey:session:{phone}
```

Payload:

```json
{
  "bridgeId": "random",
  "phone": "556699...",
  "server": "server_1",
  "status": "pending",
  "requestOptions": "{...json recebido do WA...}",
  "createdAt": "2026-06-30T00:00:00.000Z",
  "expiresAt": "2026-06-30T00:02:00.000Z"
}
```

TTL recomendado: 2 a 5 minutos.

### Endpoints

Endpoints publicos, protegidos por token curto:

```text
GET  /passkey-bridge/:bridgeId/pending
POST /passkey-bridge/:bridgeId/assertion
GET  /v15.0/:phone/passkey/status
POST /v15.0/:phone/passkey/cancel
```

`GET pending` retorna:

```json
{
  "bridge_id": "abc",
  "phone": "556699...",
  "request_options": "{...}",
  "expires_at": "..."
}
```

`POST assertion` recebe:

```json
{
  "credential_id": "base64url",
  "assertion_json": "{...json...}"
}
```

### UI

No `public/index.html` ou tela de sessao:

- mostrar estado `Aguardando passkey`;
- botao `Abrir WhatsApp Web`;
- indicador `Extensao conectada`;
- mostrar codigo Shortcake quando Baileys emitir;
- mostrar timeout/erro com instrucao objetiva.

Texto operacional:

```text
Abra o WhatsApp Web no Chrome com a extensao ativa e confirme a passkey quando solicitado.
```

## Extensao Chrome

Usar `w3nder/wa-passkey` como inspiracao direta, com adaptacao para Uno remota.

Arquivos sugeridos em repo separado ou `public/passkey-extension/`:

```text
manifest.json
background.js
content.js
inject.js
```

### Responsabilidades

- rodar apenas em `https://web.whatsapp.com/*`;
- consultar Uno API por jobs pendentes;
- executar `navigator.credentials.get()` no contexto da pagina;
- devolver assertion para Uno;
- mostrar widget de status no canto da pagina;
- permitir verificar se existe passkey antes de iniciar pareamento;
- informar ao operador se a passkey e `platform` ou `cross-platform`;
- nunca armazenar chave privada;
- nunca registrar passkey nova;
- nao logar `assertion_json` completo.

### Configuracao

A extensao precisa saber:

- URL publica da Uno;
- token de operador ou token temporario por pareamento;
- `bridgeId` atual ou endpoint que lista jobs permitidos ao operador.

### UX minima da extensao

Estados sugeridos:

```text
Uno bridge offline
Uno bridge online
Aguardando job de passkey
Passkey solicitada, confirme no navegador
Assinado, enviando para Uno
Assinatura entregue
Erro ao assinar
```

Botao de diagnostico:

```text
Verificar passkey
```

Resultado esperado:

```text
Passkey encontrada: platform
Passkey encontrada: cross-platform
Passkey nao encontrada ou cancelada
```

Esse diagnostico deve aparecer tambem na Uno para reduzir suporte: se for `cross-platform`, orientar o operador a aproximar o celular/chave e manter Bluetooth ativo.

## Alteracoes no VoIP

O VoIP nao deve assinar passkey nem participar do protocolo Shortcake.

Alteracoes recomendadas:

1. Documentar que sessoes pareadas por passkey sao indistinguiveis depois do login.
2. Garantir que o VoIP consome `creds.me`, `selfJid`, `selfLid` e auth store normalmente apos pareamento.
3. Se houver assistente de pareamento no VoIP, ele deve chamar endpoints da Uno, nao implementar ponte propria.
4. Logs de VoIP devem incluir se a sessao foi pareada via passkey apenas como metadado opcional.
5. Se a tela/servico VoIP iniciar pareamento no futuro, deve redirecionar para o fluxo de passkey da Uno e reaproveitar o mesmo `bridgeId`.

Fluxo:

```text
Uno pareia sessao com Baileys + passkey
  |
auth Redis atualizado
  |
VoIP usa a mesma sessao/auth como hoje
```

## Seguranca

Regras obrigatorias:

- `bridgeId` aleatorio forte.
- token one-time por pareamento.
- TTL curto no Redis.
- apagar assertion apos consumo.
- aceitar assertion apenas uma vez.
- vincular `bridgeId` ao `phone` e ao `server`.
- nao permitir que a extensao liste jobs de outras sessoes/operadores.
- nao logar `assertion_json`, `credential_id` completo ou `requestOptions` completos em producao.
- rate limit por IP/operador.
- CORS restrito quando possivel.
- validar `Origin`/`Referer` para `https://web.whatsapp.com` quando enviado.

## Observabilidade

Logs seguros:

```text
PASSKEY pending bridgeId=... phone=...
PASSKEY assertion received bridgeId=... credentialIdLen=...
PASSKEY prologue sent bridgeId=...
PASSKEY shortcake code emitted bridgeId=... code=...
PASSKEY encrypted pairing request sent bridgeId=...
PASSKEY completed phone=...
PASSKEY timeout bridgeId=...
```

Evitar:

- requestOptions completo;
- assertion_json completo;
- credential_id completo;
- qualquer material de chave.

## Plano por fases

### Fase 1: Baileys core

- Criar tipos de passkey.
- Criar modulo Shortcake.
- Tratar `passkey_prologue_request`.
- Tratar `crsc_continuation`.
- Emitir eventos `passkey.update`.
- Testes unitarios para:
  - commitment;
  - codigo Shortcake;
  - HKDF salt/info;
  - AES-GCM de `EncryptedPairingRequest`.

### Fase 2: Uno bridge

- Criar store Redis dos jobs.
- Criar endpoints `pending`, `assertion`, `status`, `cancel`.
- Implementar `PasskeyAuthenticator` da Uno que aguarda assertion via Redis.
- Integrar eventos Baileys com status da sessao.
- UI minima no painel.

### Fase 3: Extensao Chrome

- Adaptar `w3nder/wa-passkey` para Uno remota.
- Poll de jobs pendentes.
- Injetar signer em `web.whatsapp.com`.
- Enviar assertion para Uno.
- Tela simples da extensao com status.
- Botao `Verificar passkey`.
- Exibir `platform` vs `cross-platform`.

### Fase 4: Validacao real

- Testar com uma conta que exige passkey.
- Testar Windows Hello.
- Testar Google Password Manager.
- Testar chave fisica se disponivel.
- Validar timeout e cancelamento.
- Validar que sessao pareada envia/recebe mensagem normal.
- Validar que VoIP continua lendo `selfJid`/`selfLid`.

### Fase 5: Operacao

- Criar release da Baileys.
- Atualizar referencia da Uno para branch/tag publicada.
- Atualizar imagem da Uno.
- Documentar instalacao da extensao.
- Criar troubleshooting:
  - extensao nao conectada;
  - navegador sem passkey;
  - timeout;
  - codigo Shortcake nao bate;
  - pareamento cancelado no celular.

## Riscos

- WhatsApp alterar formato dos nodes Shortcake.
- Browser nao permitir passkey se a aba nao estiver em `web.whatsapp.com`.
- Perfil Chrome do operador nao possuir a passkey.
- Usuario tentar rodar em navegador sandbox sem login Google/Apple.
- Timeout durante confirmacao da passkey.
- Logs vazarem assertion se nao forem filtrados.

## Decisao recomendada

Implementar primeiro o caminho:

```text
Baileys core + Uno Redis bridge + extensao Chrome baseada em w3nder/wa-passkey
```

Nao implementar neste primeiro ciclo:

- passkey virtual/headless;
- browser dentro do container;
- Playwright para assinar passkey;
- dependencia do VoIP para pareamento.

Esse caminho preserva compatibilidade com VPS/docker e usa o unico lugar onde a passkey real normalmente existe: o navegador do operador.
