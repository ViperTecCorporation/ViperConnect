import { useViperVoiceBaileys, type ViperVoiceAdapterHandle } from '../src'

type UnoSession = {
  id: string
  phoneNumber: string
  sock: any
}

const voiceAdapters = new Map<string, ViperVoiceAdapterHandle>()

export async function attachUnoSessionToVoice(session: UnoSession) {
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

export function detachUnoSessionFromVoice(sessionId: string) {
  voiceAdapters.get(sessionId)?.close()
  voiceAdapters.delete(sessionId)
}
