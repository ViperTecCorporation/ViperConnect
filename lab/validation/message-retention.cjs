// Run only in the lab worker: pipe this file to `docker exec -i <lab-worker> node`.
// Uses a random synthetic prefix and removes only those fixture keys in finally.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const Redis = require('ioredis')
const { WaMessageRedisStore } = require('@zapo-js/store-redis')
const { RedisMessageRetention } = require('./dist/src/services/messages/redis_message_retention')
const { SessionMessageIndex } = require('./dist/src/services/messages/session_message_index')
const { SET_RETAINED_MESSAGE_LUA } = require('./dist/src/services/messages/message_retention')
const { setRetainedMessageStatus } = require('./dist/src/services/messages/message_status_retention')
const redis = new Redis(process.env.REDIS_URL)
const prefix = `codex_retention_fixture:${randomUUID().replace(/-/g, '')}:`
const ttl = 30 * 86400000
const day = 86400000
const now = Date.now()
const key = id => `${prefix}msg:fixture:${id}`
const idx = thread => `${prefix}msg:idx:fixture:${thread}`
const native = new WaMessageRedisStore({ redis, keyPrefix: prefix, sessionId: 'fixture', ttlMs: ttl })
const retention = new RedisMessageRetention(redis, prefix, 'fixture', native, ttl)
const record = (id, timestampMs, threadJid = '123@lid') => ({ id, timestampMs, threadJid, fromMe: false, messageBytes: Buffer.from([0, 255, 1]) })
const roughly = (actual, expected) => assert.ok(Math.abs(actual - expected) < 10000, `TTL ${actual} != ${expected}`)
;(async () => {
  try {
    await retention.write([record('recent', now - 2 * day)])
    roughly(await redis.pttl(key('recent')), ttl - 2 * day)
    assert.deepEqual((await native.getById('recent')).messageBytes, Buffer.from([0, 255, 1]))
    await Promise.all([retention.write([record('recent', now)]), retention.write([record('recent', undefined)])])
    roughly(await redis.pttl(key('recent')), ttl - 2 * day)
    assert.equal((await native.getById('recent')).timestampMs, now - 2 * day)
    await retention.write([record('recent', now, '456@lid')])
    assert.equal(await redis.zscore(idx('123@lid'), 'recent'), null)
    assert.equal(await redis.zscore(idx('456@lid'), 'recent'), String(now - 2 * day))
    roughly(await redis.pttl(idx('456@lid')), ttl - 2 * day)
    const panel = new SessionMessageIndex(redis, prefix, ttl)
    await panel.update('fixture', [await native.getById('recent')])
    roughly(await redis.pttl(panel.key('fixture', 'summary:456@lid')), ttl - 2 * day)
    await panel.state('fixture', ['recent'], { status: 'read' })
    roughly(await redis.pttl(panel.key('fixture', 'state:recent')), ttl - 2 * day)
    // Old history is not persisted; reprocessing an old sliding-TTL record removes only that record.
    await native.upsert(record('old', now - 31 * day))
    assert.equal(await retention.getById('old'), null)
    await retention.write([record('old', now)])
    assert.equal(await redis.exists(key('old'), `${key('old')}:message_bytes`), 0)
    assert.equal(await redis.zscore(idx('123@lid'), 'old'), null)
    await retention.write([record('ancient', now - 60 * day), record('future', now + 100 * day), record('missing', undefined)])
    assert.equal(await native.getById('ancient'), null)
    assert.ok((await native.getById('future')).timestampMs <= Date.now())
    roughly(await redis.pttl(key('future')), ttl)
    await redis.pexpire(key('missing'), 60000)
    await retention.write([record('missing', undefined)])
    assert.ok(await redis.pttl(key('missing')) <= 60000)
    // Compatibility copy uses the exact same atomic deadline guard.
    const copy = `${prefix}compatibility`
    await redis.eval(SET_RETAINED_MESSAGE_LUA, 1, copy, now, ttl, now - 8 * day, 'body')
    roughly(await redis.pttl(copy), ttl - 8 * day)
    await redis.eval(SET_RETAINED_MESSAGE_LUA, 1, copy, Date.now(), ttl, Date.now(), 'updated')
    roughly(await redis.pttl(copy), ttl - 8 * day)
    await redis.eval(SET_RETAINED_MESSAGE_LUA, 1, copy, Date.now(), ttl, now - 31 * day, 'old')
    assert.equal(await redis.exists(copy), 0)
    const statusClient = { mGet: keys => redis.mget(...keys), eval: (script, options) => redis.eval(script, options.keys.length, ...options.keys, ...options.arguments) }
    const statusOptions = { ttlMs: ttl, nativeTtlMs: ttl, nativePrefix: prefix, basePrefix: prefix }
    const statusKey = id => `${prefix}message-status:fixture:${id}`
    await setRetainedMessageStatus(statusClient, 'fixture', 'recent', 'delivered', statusOptions)
    roughly(await redis.pttl(statusKey('recent')), ttl - 2 * day)
    await redis.set(`${prefix}id_rev:fixture:UNO`, 'recent')
    await redis.set(statusKey('UNO'), 'sent', 'PX', ttl)
    await setRetainedMessageStatus(statusClient, 'fixture', 'UNO', 'read', statusOptions)
    roughly(await redis.pttl(statusKey('UNO')), ttl - 2 * day)
    assert.equal(await redis.get(statusKey('recent')), 'delivered')
    await redis.pexpire(statusKey('recent'), 60000)
    await setRetainedMessageStatus(statusClient, 'fixture', 'UNO', 'read', statusOptions)
    assert.ok(await redis.pttl(statusKey('UNO')) <= 60000)
    // Scheduled/error statuses without a body do not refresh on repeated updates.
    await setRetainedMessageStatus(statusClient, 'fixture', 'scheduled', 'scheduled', statusOptions)
    roughly(await redis.pttl(statusKey('scheduled')), ttl)
    await redis.pexpire(statusKey('scheduled'), 50000)
    await Promise.all(['sent', 'failed'].map(status => setRetainedMessageStatus(statusClient, 'fixture', 'scheduled', status, statusOptions)))
    assert.ok(await redis.pttl(statusKey('scheduled')) <= 50000)
    assert.equal(await redis.exists(statusKey('recent')), 1)
    await native.upsert(record('expired_status', now - 31 * day))
    await redis.set(statusKey('expired_status'), 'sent', 'PX', ttl)
    await setRetainedMessageStatus(statusClient, 'fixture', 'expired_status', 'read', statusOptions)
    assert.equal(await redis.exists(statusKey('expired_status')), 0)
    // Legacy copies are decoded and capped by original date, not their old sliding TTL.
    await redis.set(`${prefix}key:fixture:legacy`, JSON.stringify({ id: 'legacy', remoteJid: '456@lid' }))
    await redis.set(`${prefix}message:fixture:456@lid:legacy`, JSON.stringify({ messageTimestamp: Math.floor((now - 20 * day) / 1000) }), 'PX', ttl)
    await setRetainedMessageStatus(statusClient, 'fixture', 'legacy', 'read', statusOptions)
    roughly(await redis.pttl(statusKey('legacy')), ttl - 20 * day)
    assert.equal(await redis.exists(statusKey('missing')), 0)
    console.log('PASS status retention: native/copy original age, fixed fallback, alias cap, concurrent updates, expired message')
    console.log('PASS Redis retention: original age, binary body, concurrent replay, missing/future dates, index move/pruning, compatibility copy')
  } finally {
    let cursor = '0'
    let removed = 0
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = next
      if (keys.length) removed += await redis.unlink(...keys)
    } while (cursor !== '0')
    console.log(`Synthetic fixture cleanup: ${removed} keys removed`)
    await redis.quit()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
