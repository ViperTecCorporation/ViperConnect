import { MobileDeviceError } from '../mobile_device_service'

export function mergeMobileWebhooks(current: any[], incoming: unknown): any[] {
  if (!Array.isArray(incoming) || incoming.some(hook => !hook || typeof hook.id !== 'string' || !hook.id.trim() || ![hook.urlAbsolute, hook.url].some(url => typeof url === 'string' && url.trim()))) throw new MobileDeviceError(400, 'mobile_webhooks_invalid')
  const merged = new Map(current.map(hook => [hook.id, hook]))
  for (const hook of incoming) merged.set(hook.id, { ...merged.get(hook.id), ...hook })
  return [...merged.values()]
}

/** Exact selectors only: domains and request origin are not webhook identities. */
export function remainingMobileWebhooks(current: any[], input: unknown): any[] {
  const selectors = (input as any)?.webhooks
  if (!Array.isArray(selectors) || selectors.length === 0) throw new MobileDeviceError(400, 'mobile_webhooks_required')
  const removed = new Set<number>()
  for (const selector of selectors) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new MobileDeviceError(400, 'mobile_webhook_selector_invalid')
    const id = typeof selector.id === 'string' ? selector.id.trim() : ''
    const url = typeof selector.urlAbsolute === 'string' && selector.urlAbsolute ? selector.urlAbsolute : typeof selector.url === 'string' ? selector.url : ''
    if (!id && !url) throw new MobileDeviceError(400, 'mobile_webhook_selector_invalid')
    const matches = current.flatMap((hook, index) => (id ? hook.id === id : (hook.urlAbsolute || hook.url) === url) ? [index] : [])
    if (matches.length > 1) throw new MobileDeviceError(409, 'mobile_webhook_selector_ambiguous')
    if (matches.length && id && url && (current[matches[0]].urlAbsolute || current[matches[0]].url) !== url) throw new MobileDeviceError(409, 'mobile_webhook_selector_mismatch')
    // Repeated deregistration of an already removed exact selector is idempotent.
    for (const index of matches) removed.add(index)
  }
  return current.filter((_, index) => !removed.has(index))
}
