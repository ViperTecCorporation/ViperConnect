export const WHATSAPP_ENGINES = ['baileys', 'zapo'] as const

export type WhatsAppEngine = (typeof WHATSAPP_ENGINES)[number]
export type SessionProvider = WhatsAppEngine | 'forwarder'

export const isWhatsAppEngine = (value: unknown): value is WhatsAppEngine =>
  WHATSAPP_ENGINES.includes(value as WhatsAppEngine)
