import { proto, type WaStoredMessageRecord } from 'zapo-js'
import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

const MAX_BYTES = 8 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Scope = { phone: string; thread: string; providerId: string; now: number; legacyTtlMs: number; nativeTtlMs: number; legacyExpiresAt?: number }
type CompactCopy = { format: 'unoapi-copy-experiment-v1'; phone: string; thread: string; providerId: string;
  deadline: number; digest: string; contentDigest: string; envelope: string; fallback: string }
export type CopyExperiment = { stored: string; compacted: boolean; reason: string; legacyBytes: number; candidateBytes: number; pointerOnlyBytes?: number }

/** DEV experiment only. No persistence, ID generation, mapping updates or network calls. */
export function proposeMessageCopy(stored: string, native: WaStoredMessageRecord | null, scope: Scope): CopyExperiment {
  const keep = (reason: string): CopyExperiment => ({ stored, compacted: false, reason, legacyBytes: Buffer.byteLength(stored), candidateBytes: Buffer.byteLength(stored) })
  if (!stored || stored.trim().startsWith('{') || stored.trim().startsWith('[')) return keep('legacy_json_preserved')
  let original: proto.WebMessageInfo
  let raw: Buffer
  try {
    raw = Buffer.from(stored, 'base64')
    if (!raw.length || raw.length > MAX_BYTES) return keep('size_limit')
    original = proto.WebMessageInfo.decode(raw)
  } catch { return keep('invalid_legacy') }
  if (!native?.messageBytes?.length) return keep('native_missing')
  if (native.id !== scope.providerId || native.threadJid !== scope.thread || original.key?.remoteJid !== scope.thread) return keep('identity_mismatch')
  if (typeof original.key?.fromMe !== 'boolean' || native.fromMe !== original.key.fromMe) return keep('author_mismatch')
  if (!scope.phone || !original.key?.id || !original.message) return keep('incomplete_envelope')
  if (![scope.now, scope.legacyTtlMs, scope.nativeTtlMs, native.timestampMs].every(value => Number.isFinite(value) && value! > 0)) return keep('invalid_retention')
  const timestamp = Number(original.messageTimestamp) * 1000
  if (!Number.isFinite(timestamp) || timestamp <= 0 || Math.abs(timestamp - native.timestampMs!) >= 1000) return keep('timestamp_mismatch')
  const deadline = Math.min(timestamp + scope.legacyTtlMs, scope.legacyExpiresAt ?? Infinity)
  if (deadline <= scope.now || native.timestampMs! + scope.nativeTtlMs <= scope.now) return keep('expired')
  let content: Uint8Array
  try {
    content = proto.Message.encode(proto.Message.decode(native.messageBytes)).finish()
    if (!Buffer.from(content).equals(Buffer.from(proto.Message.encode(original.message).finish()))) return keep('content_mismatch')
  } catch { return keep('invalid_native') }
  const shell = proto.WebMessageInfo.decode(raw)
  shell.message = null
  const copy: CompactCopy = { format: 'unoapi-copy-experiment-v1', phone: scope.phone, thread: scope.thread,
    providerId: scope.providerId, deadline, digest: hash(raw), contentDigest: hash(content),
    envelope: Buffer.from(proto.WebMessageInfo.encode(shell).finish()).toString('base64'),
    // Mutable/expired native records cannot make an old copy unreadable.
    fallback: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }).toString('base64') }
  const encoded = JSON.stringify(copy)
  const { fallback: _fallback, ...pointer } = copy
  if (Buffer.byteLength(encoded) + 64 >= Buffer.byteLength(stored)) return { ...keep('not_smaller'), pointerOnlyBytes: Buffer.byteLength(JSON.stringify(pointer)) }
  return { stored: encoded, compacted: true, reason: 'lossless_compact', legacyBytes: Buffer.byteLength(stored),
    candidateBytes: Buffer.byteLength(encoded), pointerOnlyBytes: Buffer.byteLength(JSON.stringify(pointer)) }
}

/** Restores the exact old envelope; native content is used only after digest checks. */
export function readMessageCopy(stored: string, native: WaStoredMessageRecord | null,
  scope: Pick<Scope, 'phone' | 'thread' | 'now'>): { message: proto.IWebMessageInfo; source: string } | undefined {
  if (!stored.trim().startsWith('{') && !stored.trim().startsWith('[')) {
    try { return { message: proto.WebMessageInfo.decode(Buffer.from(stored, 'base64')), source: 'legacy' } } catch { return }
  }
  let copy: CompactCopy
  try { copy = JSON.parse(stored) } catch { return }
  if (!copy || copy.format !== 'unoapi-copy-experiment-v1') return { message: copy as proto.IWebMessageInfo, source: 'legacy_json' }
  if (copy.phone !== scope.phone || copy.thread !== scope.thread || copy.deadline <= scope.now) return
  try {
    if (native?.id === copy.providerId && native.threadJid === copy.thread && native.messageBytes?.length) {
      const content = proto.Message.decode(native.messageBytes)
      if (hash(proto.Message.encode(content).finish()) === copy.contentDigest) {
        const message = proto.WebMessageInfo.decode(Buffer.from(copy.envelope, 'base64'))
        message.message = content
        if (native.fromMe === message.key?.fromMe && hash(proto.WebMessageInfo.encode(message).finish()) === copy.digest) return { message, source: 'native' }
      }
    }
  } catch { /* Compressed fallback remains independent of native storage. */ }
  try {
    const bytes = brotliDecompressSync(Buffer.from(copy.fallback, 'base64'), { maxOutputLength: MAX_BYTES })
    if (hash(bytes) !== copy.digest) return
    const message = proto.WebMessageInfo.decode(bytes)
    if (message.key?.remoteJid !== scope.thread) return
    return { message, source: 'compressed_fallback' }
  } catch { return }
}
