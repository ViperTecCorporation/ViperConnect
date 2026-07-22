import { SessionProvider, WhatsAppEngine, isWhatsAppEngine } from './provider_types'

export const DEFAULT_WHATSAPP_ENGINE: WhatsAppEngine = 'baileys'

export const resolveSessionProvider = (value: unknown): SessionProvider => {
  if (value === 'forwarder') return 'forwarder'
  return isWhatsAppEngine(value) ? value : DEFAULT_WHATSAPP_ENGINE
}

export const resolveWhatsAppEngine = (value: unknown): WhatsAppEngine => {
  const provider = resolveSessionProvider(value)
  return provider === 'zapo' ? 'zapo' : DEFAULT_WHATSAPP_ENGINE
}
