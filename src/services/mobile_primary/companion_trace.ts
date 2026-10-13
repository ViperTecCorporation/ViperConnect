import { companionDiagnostic } from './companion_diagnostic'
import { companionAttributeValues, companionProtoSummary, safeCompanionPlatform } from './companion_trace_fields'

const tags = new Set(['iq', 'pair-device', 'ref', 'pub-key', 'device-identity', 'key-index-list', 'client-props', 'device-props', 'pem', 'ttl', 'key-id', 'error', 'device', 'link_code_companion_reg', 'remove-companion-device', 'remove-companion-devices'])
const attrs = new Set(['type', 'xmlns', 'to', 'id', 'jid', 'code', 'text', 'ts', 'ts_s', 'version', 'algorithm'])
const reasons = new Set(['bad-request', 'bad request', 'not-authorized', 'forbidden', 'not-allowed', 'resource-constraint', 'conflict', 'item-not-found', 'gone', 'invalid', 'expired', 'unknown'])

/** Match the SDK trailing-field parser; never expose QR contents or keys. */
export function companionQrShape(qr: string) {
  const parts = qr.split(',')
  const keys = parts.slice(-4, -1)
  return {
    parts: parts.length,
    referenceBytes: Buffer.byteLength(parts.slice(0, -4).join(',')),
    noiseKeyBytes: keys[0] ? Buffer.from(keys[0], 'base64').length : 0,
    identityKeyBytes: keys[1] ? Buffer.from(keys[1], 'base64').length : 0,
    advSecretBytes: keys[2] ? Buffer.from(keys[2], 'base64').length : 0,
    platformPresent: !!parts[parts.length - 1],
    ...(safeCompanionPlatform(parts[parts.length - 1]) ? { platform: safeCompanionPlatform(parts[parts.length - 1]) } : {}),
  }
}

export function safeProviderReason(value: unknown): string {
  return typeof value === 'string' && reasons.has(value.toLowerCase()) ? value.toLowerCase() : 'redacted'
}

/** Bounded structure + explicit non-secret fields; no raw binary/string content. */
export function companionNodeShape(node: any, depth = 0): unknown {
  if (!node || depth > 4) return { truncated: true }
  const content = node.content
  return {
    tag: tags.has(node.tag) ? node.tag : 'other',
    attributes: Object.keys(node.attrs || {}).slice(0, 20).map(key => attrs.has(key) ? key : 'other'),
    safeAttributes: companionAttributeValues(node.attrs),
    ...companionProtoSummary(node.tag, content),
    ...(Array.isArray(content) ? { children: content.slice(0, 20).map(child => companionNodeShape(child, depth + 1)), ...(content.length > 20 ? { truncatedChildren: content.length - 20 } : {}) }
      : { bytes: typeof content === 'string' ? Buffer.byteLength(content) : content instanceof Uint8Array ? content.byteLength : 0 }),
    ...(node.tag === 'error' ? {
      providerCode: /^\d{3}$/.test(String(node.attrs?.code)) ? Number(node.attrs.code) : undefined,
      providerReason: safeProviderReason(node.attrs?.text ?? node.attrs?.type),
    } : {}),
  }
}

/** Temporary observer for the verified Zapo 1.9 coordinator query boundary.
 * Never changes arguments, return values, thrown errors, or the global logger. */
export function observeCompanionQuery(mobile: object, emit: (event: string, data: unknown) => void): () => void {
  const target = mobile as any
  const original = target.queryWithContext
  const log = (event: string, data: unknown) => { try { emit(event, data) } catch { /* diagnostics cannot break pairing */ } }
  if (typeof original !== 'function') { log('MOBILE_COMPANION_TRACE_UNAVAILABLE', {}); return () => undefined }
  const wrapped = async function (this: unknown, ...args: any[]) {
    const stages: Record<string, string> = { 'companion-host.pair-device': 'PAIR', 'companion-host.primary-hello': 'PRIMARY_HELLO', 'companion-host.key-index-list': 'KEY_INDEX', 'companion-host.remove-device': 'REMOVE', 'companion-host.remove-all-devices': 'REMOVE_ALL' }
    const stage = stages[args[0]]
    if (!stage) return original.apply(this, args)
    const startedAt = Date.now()
    try { log(`MOBILE_COMPANION_${stage}_REQUEST`, companionNodeShape(args[1])) } catch { /* observer only */ }
    try {
      const response = await original.apply(this, args)
      try { log(`MOBILE_COMPANION_${stage}_RESPONSE`, { ...(companionNodeShape(response) as object), elapsedMs: Date.now() - startedAt }) } catch { /* observer only */ }
      return response
    } catch (error) {
      log(`MOBILE_COMPANION_${stage}_QUERY_FAILED`, { elapsedMs: Date.now() - startedAt, diagnostic: companionDiagnostic(error) })
      throw error
    }
  }
  target.queryWithContext = wrapped
  return () => { if (target.queryWithContext === wrapped) target.queryWithContext = original }
}
