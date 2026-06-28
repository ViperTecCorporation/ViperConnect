import { useViperVoiceBaileys } from '../src'

async function attachExistingSlot(sock: any) {
  return useViperVoiceBaileys({
    serviceUrl: 'https://voip.seudominio.com',
    provisionToken: process.env.VIPER_VOICE_PROVISION_TOKEN,
    slotId: 'slot_5566996269251_a',
    routingMode: 'attach_slot',
    software: 'unoapi',
    instanceId: 'session-5566996269251',
    sock,
  })
}

void attachExistingSlot({} as any)
