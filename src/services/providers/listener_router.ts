import type { Broadcast } from '../broadcast'
import type { getConfig } from '../config'
import type { eventType, Listener } from '../listener'
import type { Outgoing } from '../outgoing'
import { ListenerBaileys } from '../listener_baileys'
import { ListenerZapo } from '../listener_zapo'
import { resolveWhatsAppEngine } from './provider_resolver'

export class ProviderListener implements Listener {
  readonly baileys: Listener
  readonly zapo: Listener

  constructor(outgoing: Outgoing, broadcast: Broadcast, private readonly getConfig: getConfig) {
    this.baileys = new ListenerBaileys(outgoing, broadcast, getConfig)
    this.zapo = new ListenerZapo(outgoing, broadcast, getConfig)
  }

  async process(phone: string, messages: object[], type: eventType) {
    const config = await this.getConfig(phone)
    return this.forProvider(resolveWhatsAppEngine(config.provider)).process(phone, messages, type)
  }

  forProvider(provider: 'baileys' | 'zapo') {
    return provider === 'zapo' ? this.zapo : this.baileys
  }
}

export const listenerForProvider = (listener: Listener, provider: 'baileys' | 'zapo') => {
  const selectable = listener as Listener & { forProvider?: (value: 'baileys' | 'zapo') => Listener }
  return selectable.forProvider?.(provider) || listener
}
