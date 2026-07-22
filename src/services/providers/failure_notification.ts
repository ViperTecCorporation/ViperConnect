import type { WhatsAppEngine } from './provider_types'

export const shouldNotifyFailureByWhatsApp = (
  engine: WhatsAppEngine,
  configured: boolean,
): boolean => configured && engine !== 'zapo'
