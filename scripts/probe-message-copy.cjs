/* Read-only differential probe. Prints aggregates only; never sends messages or writes Redis. */
process.env.UNO_LOG_LEVEL = 'silent'
const { performance } = require('node:perf_hooks')
const { isDeepStrictEqual } = require('node:util')
const path = require('node:path')
const Redis = require('ioredis')
const { proto } = require('zapo-js')

async function runMessageCopyProbe(codec, limit = 200) {
  const { ZapoMessageEdit, buildZapoEditContent } = require(path.resolve('dist/src/services/zapo/zapo_message_edit'))
  const { ZapoMessages } = require(path.resolve('dist/src/services/zapo/zapo_messages'))
  const prefix = require(path.resolve('dist/src/services/zapo/zapo_store')).resolveZapoRedisKeyPrefix(process.env.ZAPO_REDIS_KEY_PREFIX)
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 10000 })
  await redis.connect()
  const result = { sampled: 0, compacted: 0, equivalent: 0, mismatches: 0, legacyStringBytes: 0, candidateStringBytes: 0,
    hypotheticalPointerOnlyBytes: 0, nativeEquivalent: 0, reasons: {}, types: {}, publicIdPreserved: 0, referenceIdPreserved: 0,
    missingNativePreserved: 0, changedNativePreserved: 0, editConsumerCompared: 0, editConsumerMismatch: 0,
    recoveryConsumerCompared: 0, recoveryConsumerMismatch: 0, encodeMs: 0, decodeMs: 0, readOnly: true, realSends: 0 }
  const sessions = new Set()
  const encode = message => Buffer.from(proto.WebMessageInfo.encode(message).finish())
  const capture = async operation => { try { return { value: await operation() } } catch (error) { return { error: { name: error.name, message: error.message } } } }
  try {
    let cursor = '0', keys = []
    for (let i = 0; i < 30 && keys.length < limit; i++) {
      const page = await redis.scan(cursor, 'MATCH', 'unoapi-message:*', 'COUNT', 1000)
      cursor = page[0]; keys.push(...page[1])
      if (cursor === '0') break
    }
    for (const key of keys.slice(0, limit)) {
      const match = key.match(/^unoapi-message:(\d+):(.+):([^:]+)$/)
      if (!match) continue
      const phone = match[1], thread = match[2], stored = await redis.get(key)
      if (!stored) continue
      let old
      try { old = stored.trim().startsWith('{') ? JSON.parse(stored) : proto.WebMessageInfo.decode(Buffer.from(stored, 'base64')) } catch { continue }
      let provider = match[3], header = {}
      const seen = new Set()
      for (let i = 0; i < 8; i++) {
        header = await redis.hgetall(`${prefix}msg:${phone}:${provider}`)
        if (header.id || seen.has(provider)) break
        seen.add(provider)
        const next = await redis.get(`unoapi-id_rev:${phone}:${provider}`)
        if (!next || next === provider) break
        provider = next
      }
      const raw = header.id ? await redis.getBuffer(`${prefix}msg:${phone}:${provider}:message_bytes`) : null
      const native = header.id ? { id: header.id, threadJid: header.thread_jid, fromMe: header.from_me === '1', timestampMs: Number(header.timestamp_ms), messageBytes: raw } : null
      const now = Date.now(), ttl = await redis.pttl(key)
      const scope = { phone, thread, providerId: provider, now, legacyTtlMs: Number(process.env.DATA_TTL || 2592000) * 1000,
        nativeTtlMs: Number(process.env.ZAPO_REDIS_MESSAGES_TTL_MS || 2592000000), ...(ttl >= 0 ? { legacyExpiresAt: now + ttl } : {}) }
      let start = performance.now()
      const proposed = codec.proposeMessageCopy(stored, native, scope)
      result.encodeMs += performance.now() - start; start = performance.now()
      const restored = codec.readMessageCopy(proposed.stored, native, scope)
      result.decodeMs += performance.now() - start
      result.sampled++; sessions.add(phone)
      result.legacyStringBytes += proposed.legacyBytes; result.candidateStringBytes += proposed.candidateBytes
      result.hypotheticalPointerOnlyBytes += Math.min(proposed.legacyBytes, proposed.pointerOnlyBytes ?? proposed.legacyBytes)
      if (proposed.pointerOnlyBytes !== undefined) result.nativeEquivalent++
      result.reasons[proposed.reason] = (result.reasons[proposed.reason] || 0) + 1
      const type = Object.keys(old.message || {}).find(k => k !== 'messageContextInfo') || 'no_content'
      result.types[type] = (result.types[type] || 0) + 1
      if (!restored || !encode(old).equals(encode(restored.message))) { result.mismatches++; continue }
      result.equivalent++
      if (restored.message.key?.id === old.key?.id) result.publicIdPreserved++
      const reference = m => m?.message?.extendedTextMessage?.contextInfo?.stanzaId || m?.message?.reactionMessage?.key?.id || m?.message?.protocolMessage?.key?.id
      if (reference(restored.message) === reference(old)) result.referenceIdPreserved++
      if (proposed.compacted) {
        result.compacted++
        for (const kind of ['missing', 'changed']) {
          const changed = kind === 'missing' ? null : { ...native, messageBytes: proto.Message.encode({ conversation: 'synthetic changed content' }).finish() }
          const fallback = codec.readMessageCopy(proposed.stored, changed, scope)
          if (fallback && encode(fallback.message).equals(encode(old))) result[kind === 'missing' ? 'missingNativePreserved' : 'changedNativePreserved']++
        }
      }
      // Exercise real consumers with fake storage and a fake sender. No real client/socket exists.
      const edit = message => new ZapoMessageEdit({ loadMessageExact: async () => message }).original(message.key)
        .then(content => buildZapoEditContent(content, 'synthetic edit probe'))
      const a = await capture(() => edit(old)), b = await capture(() => edit(restored.message))
      result.editConsumerCompared++; if (!isDeepStrictEqual(a, b)) result.editConsumerMismatch++
      const uno = await redis.get(`unoapi-id:${phone}:${provider}`) || old.key.id
      const recovery = async message => {
        let delivered
        const cache = { loadProviderId: async id => id === uno && id !== provider ? provider : undefined,
          loadKey: async () => message.key, loadMessage: async () => message, setUnoId: async () => uno, setKey: async () => undefined }
        const client = { message: { send: async (...args) => { delivered = args; return { id: provider } } } }
        const consumer = new ZapoMessages(client, cache, { phone })
        const response = await consumer.recoverDelivery({ message_id: uno, to: thread })
        return { delivered, response }
      }
      const ra = await capture(() => recovery(old)), rb = await capture(() => recovery(restored.message))
      result.recoveryConsumerCompared++; if (!isDeepStrictEqual(ra, rb)) result.recoveryConsumerMismatch++
    }
    result.sessions = sessions.size
    result.savingPercent = 100 * (1 - result.candidateStringBytes / Math.max(1, result.legacyStringBytes))
    result.hypotheticalUnsafePointerSavingPercent = 100 * (1 - result.hypotheticalPointerOnlyBytes / Math.max(1, result.legacyStringBytes))
    return result
  } finally { await redis.quit() }
}
module.exports = { runMessageCopyProbe }
