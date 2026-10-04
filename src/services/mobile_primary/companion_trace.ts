const tags = new Set(['iq', 'pair-device', 'ref', 'pub-key', 'device-identity', 'key-index-list', 'client-props', 'pem', 'ttl', 'key-id', 'error', 'device'])
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
  }
}

export function safeProviderReason(value: unknown): string {
  return typeof value === 'string' && reasons.has(value.toLowerCase()) ? value.toLowerCase() : 'redacted'
}

/** Structure only: no attribute values or binary/string content is copied. */
export function companionNodeShape(node: any, depth = 0): unknown {
  if (!node || depth > 4) return { truncated: true }
  const content = node.content
  return {
    tag: tags.has(node.tag) ? node.tag : 'other',
    attributes: Object.keys(node.attrs || {}).slice(0, 20).map(key => attrs.has(key) ? key : 'other'),
    ...(Array.isArray(content) ? { children: content.slice(0, 20).map(child => companionNodeShape(child, depth + 1)) }
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
    if (args[0] !== 'companion-host.pair-device') return original.apply(this, args)
    log('MOBILE_COMPANION_PAIR_REQUEST', companionNodeShape(args[1]))
    const response = await original.apply(this, args)
    log('MOBILE_COMPANION_PAIR_RESPONSE', companionNodeShape(response))
    return response
  }
  target.queryWithContext = wrapped
  return () => { if (target.queryWithContext === wrapped) target.queryWithContext = original }
}
