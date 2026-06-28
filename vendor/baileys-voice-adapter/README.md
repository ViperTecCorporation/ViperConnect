# @viperconnect/baileys-voice-adapter

SDK para conectar uma sessao Baileys/Whaileys existente ao ViperConnect VoIP
Service sem mover `creds.json` para o container de voz.

O app integrador continua dono do socket WhatsApp. O VoIP Service cuida de
SIP, audio, roteamento, historico e engine de chamada.

## Instalar

```bash
npm install @viperconnect/baileys-voice-adapter ws
```

## Sessao unica

Use quando o seu processo possui uma sessao Baileys/Whaileys e quer criar ou
reutilizar automaticamente uma linha/slot/ramal no VoIP Service.

```ts
import { useViperVoiceBaileys } from '@viperconnect/baileys-voice-adapter'

const voice = await useViperVoiceBaileys({
  serviceUrl: 'https://voip.seudominio.com',
  provisionToken: process.env.VIPER_VOICE_PROVISION_TOKEN,
  phoneNumber: '5566996269251',
  software: 'unoapi',
  instanceId: 'session-5566996269251',
  displayName: 'Atendimento 5566996269251',
  sock,
})

console.log(voice.slotId)
console.log(voice.provision?.sip)
```

O provisionamento retorna as credenciais SIP para registrar o ramal:

```json
{
  "username": "5566996269251",
  "password": "gerada",
  "domain": "voip.seudominio.com",
  "wsUrl": "wss://voip.seudominio.com/sip/ws"
}
```

## Varias sessoes na Uno

Na Uno, cada sessao tem seu proprio `sock`. Instancie o SDK uma vez por sessao.

```ts
import { useViperVoiceBaileys } from '@viperconnect/baileys-voice-adapter'

const voiceAdapters = new Map()

async function onSessionReady(session) {
  voiceAdapters.get(session.id)?.close()

  const voice = await useViperVoiceBaileys({
    serviceUrl: process.env.VIPER_VOICE_SERVICE_URL,
    provisionToken: process.env.VIPER_VOICE_PROVISION_TOKEN,
    phoneNumber: session.phoneNumber,
    software: 'unoapi',
    instanceId: session.id,
    sock: session.sock,
  })

  voiceAdapters.set(session.id, voice)
  return voice.provision
}

function onSessionClosed(sessionId) {
  voiceAdapters.get(sessionId)?.close()
  voiceAdapters.delete(sessionId)
}
```

## Vincular a slot existente

Para roteamento complexo, prefira passar apenas o GUID do slot. O backend do
VoIP resolve empresa, conta, grupos, ramais e regras vinculadas ao slot.

```ts
await useViperVoiceBaileys({
  serviceUrl: 'https://voip.seudominio.com',
  provisionToken: process.env.VIPER_VOICE_PROVISION_TOKEN,
  slotId: 'slot_5566996269251_a',
  routingMode: 'attach_slot',
  software: 'unoapi',
  instanceId: 'session-5566996269251',
  sock,
})
```

## Conectar sem provisionar

Se o slot e o token bridge ja foram salvos pelo integrador:

```ts
await useViperVoiceBaileys({
  bridgeUrl: 'wss://voip.seudominio.com/baileys/bridge',
  slotId: 'slot_5566996269251_a',
  bridgeToken: 'vpb_xxxxx',
  software: 'unoapi',
  instanceId: 'session-5566996269251',
  sock,
})
```

## Baileys v7 e Whaileys v6

O SDK nao importa Baileys diretamente. Ele recebe o `sock` e detecta os metodos
disponiveis em runtime.

Inbound precisa principalmente de:

- `sock.ws.on('CB:call')`
- `sock.ws.on('CB:ack,class:call')`
- `sock.sendNode(...)`

Outbound exige tambem:

- `sock.query`
- `sock.generateMessageTag`
- `sock.onWhatsApp`
- `sock.getUSyncDevices`
- `sock.assertSessions`
- `sock.createParticipantNodes`
- `sock.signalRepository.encryptMessage`
- `sock.signalRepository.decryptMessage`

Opcional, mas recomendado para outbound com rota LID:

- `sock.signalRepository.lidMapping.getLIDForPN`

Se faltar metodo de outbound, o slot ainda pode conectar para inbound, mas o
VoIP Service deve marcar o slot fora da fila outbound com motivo
`missing_outbound_capability`.

## Ciclo de vida

Sempre feche o adapter quando a sessao Baileys for recriada, para remover
listeners antigos e fechar o WebSocket bridge.

```ts
const voice = await useViperVoiceBaileys({ ... })

// quando a sessao cair ou for recriada
voice.close()
```

## Contrato do bridge

Fluxo inicial:

1. SDK detecta capacidades do `sock`.
2. SDK chama `POST /v1/bridge/provision` quando recebe `provisionToken`.
3. SDK conecta em `/baileys/bridge`.
4. SDK envia `hello` com `slotId`, `bridgeToken`, identidade e capacidades.
5. SDK encaminha `CB:call`, `CB:ack,class:call` e `connection.update`.
6. VoIP Service chama RPCs como `sendNode`, `query`, `assertSessions`,
   `createParticipantNodes` e `signalRepository.*`.
