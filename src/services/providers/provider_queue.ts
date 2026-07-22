import { resolveWhatsAppEngine } from './provider_resolver'
import { WhatsAppEngine } from './provider_types'

export const providerQueueName = (queue: string, server: string, provider: unknown) =>
  `${queue}.${server}.${resolveWhatsAppEngine(provider)}`

export const providerFromQueueName = (queue: string): WhatsAppEngine | undefined => {
  const suffix = queue.split('.').pop()
  return suffix === 'baileys' || suffix === 'zapo' ? suffix : undefined
}
