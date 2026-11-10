/* Read-only differential probe for an explicitly isolated, already migrated DEV
 * fixture. No WaClient, HTTP, webhook, live sender, ID generation or repair.
 * Run in the owning lab worker after migration; only aggregates leave this process. */
process.env.UNO_LOG_LEVEL = 'silent'
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { performance } = require('node:perf_hooks')

function assertLab(phone, config) {
  if (process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.UNOAPI_PROCESS_ROLE !== 'worker') throw new Error('isolated_storage_worker_required')
  if (!/^[1-9]\d{7,14}$/.test(phone || '')) throw new Error('fixture_phone_required')
  if (config && (config.provider !== 'zapo' || config.server !== 'mobile_lab' || config.autoConnect !== false
    || config.sessionStorage?.backend !== 'sqlite' || config.sessionStorage?.fixture !== true
    || !['active', 'offline'].includes(config.sessionStorage?.state)
    || config.sessionStorage.owner !== (process.env.UNOAPI_STORAGE_WORKER_ID || 'mobile_lab')
    || config.webhooks?.length || config.sessionWebhook)) throw new Error('migrated_fixture_not_safe')
}

function defaultModules() {
  const load = name => require(path.resolve('dist/src/services', name))
  return {
    proto: require('zapo-js/proto').proto,
    defaultConfig: load('config').defaultConfig,
    ...load('session_storage/database'), ...load('session_storage/data_store_sqlite'),
    ...load('session_storage/native_migration'), ...load('zapo/zapo_message_edit'),
    ...load('zapo/zapo_messages'), ...load('message_id_map'),
    createSqliteStore: require('@zapo-js/store-sqlite').createSqliteStore,
  }
}

async function scan(redis, pattern, consume) {
  let cursor = '0'
  do {
    const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500); cursor = page[0]
    for (let offset = 0; offset < page[1].length; offset += 100) await consume(page[1].slice(offset, offset + 100))
    await new Promise(resolve => setImmediate(resolve))
  } while (cursor !== '0')
}

function ttlCompatible(source, target, tolerance = 2000) {
  if (source === -2) return target === undefined || target === null || target <= Date.now()
  if (source === -1) return target === null
  return typeof source === 'number' && typeof target === 'number' && Math.abs(source - target) <= tolerance
}

async function expiration(redis, key) {
  if (typeof redis.pexpiretime === 'function') return Number(await redis.pexpiretime(key))
  const before = Date.now(), remaining = Number(await redis.pttl(key))
  return remaining < 0 ? remaining : before + remaining
}

const readJson = value => value === null || value === undefined ? undefined : JSON.parse(Buffer.isBuffer(value) ? value.toString() : value)
const sameBytes = (a, b) => a == null || b == null ? a == null && b == null : Buffer.from(a).equals(Buffer.from(b))
const activeSql = '(expires_at IS NULL OR expires_at>?)'
const supportedFamilies = ['id', 'id_rev', 'key', 'message-status']

function legacyStore(redis, phone, decode) {
  const get = (kind, id) => redis.get(`unoapi-${kind}:${phone}:${id}`)
  return {
    loadUnoId: id => get('id', id).then(value => value || undefined),
    loadProviderId: id => get('id_rev', id).then(value => value || undefined),
    loadKey: id => get('key', id).then(readJson),
    loadMessage: async (jid, id) => { const value = await redis.get(`unoapi-message:${phone}:${jid}:${id}`); return value ? decode(value) : undefined },
    loadMessageExact: async (jid, id) => { const value = await redis.get(`unoapi-message:${phone}:${jid}:${id}`); return value ? decode(value) : undefined },
    loadStatus: async id => {
      const provider = await get('id_rev', id), uno = await get('id', id)
      for (const alias of [...new Set([id, provider, uno].filter(Boolean))]) { const value = await get('message-status', alias); if (value) return value }
      return undefined
    },
  }
}

async function originalNative(redis, prefix, phone, id) {
  const key = `${prefix}msg:${phone}:${id}`, data = await redis.hgetall(key)
  if (!data?.id) return null
  const bytes = await redis.getBuffer(`${key}:message_bytes`)
  return { id: data.id, threadJid: data.thread_jid, fromMe: data.from_me === '1',
    senderJid: data.sender_jid || undefined, participantJid: data.participant_jid || undefined,
    timestampMs: data.timestamp_ms ? Number(data.timestamp_ms) : undefined, messageBytes: bytes ? new Uint8Array(bytes) : undefined }
}

function typeOf(message) {
  let content = message?.message || {}
  for (let i = 0; i < 8; i++) {
    const inner = content.ephemeralMessage?.message || content.documentWithCaptionMessage?.message || content.deviceSentMessage?.message
    if (!inner) break
    content = inner
  }
  if (typeof content.conversation === 'string' || content.extendedTextMessage) return 'text'
  for (const type of ['image', 'video', 'document', 'audio', 'sticker', 'reaction', 'contact']) if (content[`${type}Message`]) return type
  if (content.protocolMessage) return 'protocol'
  if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) return 'poll'
  return 'other'
}

function reference(message) {
  const content = message?.message || {}
  const context = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.videoMessage?.contextInfo || content.documentMessage?.contextInfo
  return context?.stanzaId || content.reactionMessage?.key?.id || content.protocolMessage?.key?.id
}

async function capture(operation) {
  try { return { value: await operation() } }
  catch (error) { return { error: { name: error?.name, code: error?.code, message: error?.message } } }
}

function readOnlyRecoveryCache(real, trace) {
  return { ...real,
    // recoverDelivery is evaluated, not persisted. These are deliberately fake
    // mutators: the comparison must not alter either database or choose new IDs.
    setUnoId: async (provider, uno) => { trace.writes.push(['setUnoId', provider, uno]); return await real.loadUnoId(provider) || uno },
    setKey: async (id, key) => { trace.writes.push(['setKey', id, key]) },
    setMessage: async () => { throw new Error('probe_unexpected_archive_mutation') },
  }
}

async function recover(modules, real, phone, existingId, thread) {
  const trace = { sends: [], writes: [] }
  const fake = { message: { send: async (to, content, options) => {
    if (!options?.id) throw new Error('probe_existing_provider_id_required')
    trace.sends.push({ to, content, options }); return { id: options.id }
  } } }
  const consumer = new modules.ZapoMessages(fake, readOnlyRecoveryCache(real, trace), { phone })
  const response = await capture(() => consumer.recoverDelivery({ message_id: existingId, to: thread }))
  return { ...response, trace }
}

async function compareAllMaps(redis, db, phone) {
  // Counts use the same future cutoff on both sides. Values/TTLs are still
  // compared for every readable source key, including keys expiring soon.
  // Finishing after this cutoff is explicitly inconclusive, never a success.
  const cutoff = Date.now() + 120000
  const families = Object.fromEntries(supportedFamilies.map(name => [name, { sourceKeys: 0, sqliteKeys: 0, stableSourceKeys: 0, stableSqliteKeys: 0, expiringBeforeCutoff: 0, missingSource: 0, valuesEqual: 0, missingDestination: 0, differentValues: 0, expiredDuringRead: 0, ttlEqual: 0, ttlDifferent: 0 }]))
  const orphans = { forwardSource: 0, reverseSource: 0, forwardSqlite: 0, reverseSqlite: 0 }
  await scan(redis, `unoapi-*:${phone}:*`, async keys => {
    const selected = keys.map(key => ({ key, match: key.match(new RegExp(`^unoapi-(id|id_rev|key|message-status):${phone}:(.+)$`)) })).filter(entry => entry.match)
    if (!selected.length) return
    const pipe = redis.pipeline(); selected.forEach(({ key }) => pipe.getBuffer(key))
    const result = await pipe.exec()
    for (let i = 0; i < selected.length; i++) {
      const { key, match } = selected[i], stats = families[match[1]], row = result[i]
      if (row[0]) throw new Error('probe_source_read_failed')
      const source = row[1]
      if (!source) {
        const local = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [key])
        if (local && (local.expires_at === null || local.expires_at > Date.now())) stats.missingSource++
        else stats.expiredDuringRead++
        continue
      }
      stats.sourceKeys++
      const stored = db.get('SELECT value,expires_at FROM uno_kv WHERE key=?', [key])
      if (!stored) stats.missingDestination++
      else if (sameBytes(source, stored.value)) stats.valuesEqual++
      else stats.differentValues++
      const deadline = await expiration(redis, key), stable = deadline === -1 || deadline > cutoff
      if (stable) stats.stableSourceKeys++; else stats.expiringBeforeCutoff++
      if (stored) { if (ttlCompatible(deadline, stored.expires_at)) stats.ttlEqual++; else stats.ttlDifferent++ }
      if (stable && match[1] === 'id') {
        const reverse = await redis.get(`unoapi-id_rev:${phone}:${source.toString()}`)
        const reverseDeadline = await expiration(redis, `unoapi-id_rev:${phone}:${source.toString()}`)
        if (reverse !== match[2] || reverseDeadline !== -1 && reverseDeadline <= cutoff) orphans.forwardSource++
      } else if (stable && match[1] === 'id_rev') {
        const forward = await redis.get(`unoapi-id:${phone}:${source.toString()}`)
        const forwardDeadline = await expiration(redis, `unoapi-id:${phone}:${source.toString()}`)
        if (forward !== match[2] || forwardDeadline !== -1 && forwardDeadline <= cutoff) orphans.reverseSource++
      }
    }
  })
  for (const family of supportedFamilies) {
    const start = `unoapi-${family}:${phone}:`
    families[family].sqliteKeys = Number(db.get('SELECT COUNT(*) n FROM uno_kv WHERE key>=? AND key<? AND ' + activeSql, [start, start + '\uffff', Date.now()]).n)
    families[family].stableSqliteKeys = Number(db.get('SELECT COUNT(*) n FROM uno_kv WHERE key>=? AND key<? AND ' + activeSql, [start, start + '\uffff', cutoff]).n)
  }
  for (const [side, opposite, field] of [['id', 'id_rev', 'forwardSqlite'], ['id_rev', 'id', 'reverseSqlite']]) {
    const start = `unoapi-${side}:${phone}:`, oppositeStart = `unoapi-${opposite}:${phone}:`, now = cutoff
    orphans[field] = Number(db.get(`SELECT COUNT(*) n FROM uno_kv a LEFT JOIN uno_kv b ON b.key=?||CAST(a.value AS TEXT)
      AND (b.expires_at IS NULL OR b.expires_at>?) WHERE a.key>=? AND a.key<? AND (a.expires_at IS NULL OR a.expires_at>?)
      AND (b.key IS NULL OR CAST(b.value AS TEXT)!=substr(a.key,?))`, [oppositeStart, now, start, start + '\uffff', now, start.length + 1]).n)
  }
  return { complete: Date.now() < cutoff, comparisonCutoff: cutoff, families, orphans, orphansPreserved: orphans.forwardSource === orphans.forwardSqlite && orphans.reverseSource === orphans.reverseSqlite }
}

async function copySample(redis, phone, decode, limit) {
  const groups = new Map([['group', { seen: 0, keys: [] }], ['direct', { seen: 0, keys: [] }]])
  const maximum = limit * 3
  await scan(redis, `unoapi-message:${phone}:*`, async keys => {
    for (const key of keys) {
      const bucket = groups.get(key.includes('@g.us:') ? 'group' : 'direct'); bucket.seen++
      if (bucket.keys.length < maximum) bucket.keys.push(key)
      else { const position = Math.floor(Math.random() * bucket.seen); if (position < maximum) bucket.keys[position] = key }
    }
  })
  const strata = new Map(); let decodeFailures = 0, expired = 0
  for (const [kind, bucket] of groups) {
    for (const key of bucket.keys) {
      const raw = await redis.get(key); if (!raw) { expired++; continue }
      let message; try { message = decode(raw) } catch { decodeFailures++; continue }
      const category = `${kind}/${message.key?.fromMe ? 'own' : 'received'}/${typeOf(message)}`
      let list = strata.get(category); if (!list) { list = []; strata.set(category, list) }
      if (list.length < limit) list.push({ key, category })
    }
  }
  const selected = [], buckets = [...strata.values()]
  for (let i = 0; selected.length < limit && buckets.some(bucket => bucket[i]); i++) for (const bucket of buckets) if (bucket[i] && selected.length < limit) selected.push(bucket[i])
  return { selected, sourceCopies: [...groups.values()].reduce((sum, group) => sum + group.seen, 0), decodeFailures, expired }
}

async function runSqliteStorageFixtureProbe(options = {}) {
  const phone = options.phone || process.env.STORAGE_FIXTURE_PHONE
  assertLab(phone)
  const modules = options.modules || defaultModules(), started = performance.now()
  const Redis = options.redis ? undefined : require('ioredis')
  if (!options.redis && !process.env.REDIS_URL) throw new Error('fixture_redis_url_required')
  const redis = options.redis || new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 30000 })
  if (!options.redis) { redis.on('error', () => {}); await redis.connect() }
  let db
  try {
    const storedConfig = readJson(await redis.get(`unoapi-config:${phone}`)); if (!storedConfig) throw new Error('fixture_config_missing')
    const config = { ...modules.defaultConfig, ...storedConfig, baseStore: process.env.SESSION_STORAGE_ROOT || storedConfig.baseStore || modules.defaultConfig.baseStore }
    assertLab(phone, config)
    const prefix = !process.env.ZAPO_REDIS_KEY_PREFIX || process.env.ZAPO_REDIS_KEY_PREFIX === 'unoapi-zapo:' ? 'unoapi:zapo:' : process.env.ZAPO_REDIS_KEY_PREFIX
    if (!/^[A-Za-z0-9_:]*$/.test(prefix)) throw new Error('fixture_prefix_invalid')
    db = modules.openSessionDatabase(phone, config)
    const beforeWrites = Number(db.get('SELECT total_changes() n').n)
    const destination = await modules.getDataStoreSqlite(phone, config)
    const legacy = legacyStore(redis, phone, modules.decodeSqliteMessage)
    const native = modules.createSqliteStore({ connection: modules.sqliteSdkConnection(db) }).stores.messages(phone)
    const requestedLimit = Number(options.limit ?? 200)
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error('probe_sample_limit_invalid')
    const limit = Math.min(200, requestedLimit), sample = await copySample(redis, phone, modules.decodeSqliteMessage, limit)
    const result = { fixture: true, productionAccess: false, liveReadNotAtomicSnapshot: true, sourceRedisWrites: 0, sqliteWrites: 0, realSends: 0,
      sourceCopyKeys: sample.sourceCopies, sampleCandidatesExpired: sample.expired, sampleDecodeFailures: sample.decodeFailures,
      copies: { compared: 0, equal: 0, missing: 0, mismatch: 0, decodeErrors: 0, ttlEqual: 0, ttlDifferent: 0, referencesEqual: 0, metadataEqual: 0, metadataDifferent: 0 },
      strata: {}, edit: { compared: 0, equal: 0, mismatch: 0, accepted: 0, rejected: 0 }, recovery: { compared: 0, equal: 0, mismatch: 0, fakeSendCalls: 0 },
      native: { compared: 0, equal: 0, missing: 0, mismatch: 0 }, maps: undefined, elapsedMs: 0, compatible: false }
    for (const entry of sample.selected) {
      const match = entry.key.match(new RegExp(`^unoapi-message:${phone}:(.+):([^:]+)$`)); if (!match) throw new Error('probe_copy_key_shape_invalid')
      const raw = await redis.get(entry.key); if (!raw) { result.sampleCandidatesExpired++; continue }
      const old = modules.decodeSqliteMessage(raw), loaded = await capture(() => destination.loadMessageExact(match[1], match[2])), restored = loaded.value
      result.copies.compared++; result.strata[entry.category] = (result.strata[entry.category] || 0) + 1
      if (loaded.error) { result.copies.decodeErrors++; result.copies.mismatch++ }
      else if (!restored) result.copies.missing++
      else {
        const equal = await capture(() => sameBytes(modules.proto.WebMessageInfo.encode(old).finish(), modules.proto.WebMessageInfo.encode(restored).finish()))
        if (equal.error) { result.copies.decodeErrors++; result.copies.mismatch++ }
        else if (equal.value) result.copies.equal++
        else result.copies.mismatch++
      }
      if (restored && reference(old) === reference(restored)) result.copies.referencesEqual++
      const row = db.get('SELECT expires_at FROM uno_kv WHERE key=?', [entry.key])
      if (row && ttlCompatible(await expiration(redis, entry.key), row.expires_at)) result.copies.ttlEqual++; else result.copies.ttlDifferent++
      for (const method of ['loadUnoId', 'loadProviderId', 'loadKey', 'loadStatus']) {
        const a = await capture(() => legacy[method](match[2])), b = await capture(() => destination[method](match[2]))
        if (isDeepStrictEqual(a, b)) result.copies.metadataEqual++; else result.copies.metadataDifferent++
      }
      if (!old.key?.id || !old.key?.remoteJid) { result.edit.rejected++; continue }
      const original = async store => new modules.ZapoMessageEdit(store).original(old.key).then(content => modules.buildZapoEditContent(content, 'synthetic caption comparison'))
      const a = await capture(() => original(legacy)), b = await capture(() => original(destination))
      result.edit.compared++; if (isDeepStrictEqual(a, b)) result.edit.equal++; else result.edit.mismatch++
      if (b.error) result.edit.rejected++; else result.edit.accepted++
      const ra = await recover(modules, legacy, phone, match[2], match[1]), rb = await recover(modules, destination, phone, match[2], match[1])
      result.recovery.compared++; result.recovery.fakeSendCalls += ra.trace.sends.length + rb.trace.sends.length
      if (isDeepStrictEqual(ra, rb)) result.recovery.equal++; else result.recovery.mismatch++
    }
    let nativeKeys = [], cursor = '0'
    do { const page = await redis.scan(cursor, 'MATCH', `${prefix}msg:${phone}:*`, 'COUNT', 500); cursor = page[0]; for (const key of page[1]) { if (key.endsWith(':message_bytes') || key.endsWith(':plaintext')) continue; if (await redis.type(key) === 'hash') nativeKeys.push(key); if (nativeKeys.length >= limit) break } } while (cursor !== '0' && nativeKeys.length < limit)
    for (const key of nativeKeys.slice(0, limit)) {
      const id = key.slice(`${prefix}msg:${phone}:`.length), original = await originalNative(redis, prefix, phone, id), migrated = await native.getById(id)
      if (!original) continue
      result.native.compared++
      if (!migrated) result.native.missing++
      else if (isDeepStrictEqual(original, migrated)) result.native.equal++
      else result.native.mismatch++
    }
    result.maps = await compareAllMaps(redis, db, phone)
    result.sqliteWrites = Number(db.get('SELECT total_changes() n').n) - beforeWrites
    result.elapsedMs = Math.round(performance.now() - started)
    result.compatible = result.copies.compared > 0 && result.copies.equal === result.copies.compared && !result.copies.ttlDifferent && !result.copies.metadataDifferent
      && !result.sampleDecodeFailures && !result.edit.mismatch && !result.recovery.mismatch && result.native.compared > 0 && !result.native.missing && !result.native.mismatch && result.sqliteWrites === 0
      && result.maps.complete && Object.values(result.maps.families).every(stats => stats.stableSourceKeys === stats.stableSqliteKeys && stats.valuesEqual === stats.sourceKeys && !stats.ttlDifferent && !stats.missingSource)
      && result.maps.orphansPreserved
    return result
  } finally { modules.closeAllSessionDatabases(); if (!options.redis) await redis.quit() }
}

module.exports = { runSqliteStorageFixtureProbe, assertLab }
if (require.main === module) runSqliteStorageFixtureProbe().then(result => { console.log(JSON.stringify(result)); process.exit(result.compatible ? 0 : 2) }).catch(error => {
  const code = /^[a-z_]{1,100}$/.test(error?.message || '') ? error.message : 'probe_read_or_decode_failed'
  console.error(JSON.stringify({ probeFailed: true, code, payloadLogged: false })); process.exit(1)
})
