import { useViperVoiceBaileys } from '../src'

async function startVoiceBridge(sock: any) {
  const voice = await useViperVoiceBaileys({
    serviceUrl: 'https://voip.seudominio.com',
    provisionToken: process.env.VIPER_VOICE_PROVISION_TOKEN,
    phoneNumber: '5566996269251',
    software: 'unoapi',
    instanceId: 'session-5566996269251',
    displayName: 'Atendimento 5566996269251',
    sock,
  })

  console.log('Viper Voice slot:', voice.slotId)
  console.log('Credenciais SIP:', voice.provision?.sip)
}

void startVoiceBridge({} as any)
