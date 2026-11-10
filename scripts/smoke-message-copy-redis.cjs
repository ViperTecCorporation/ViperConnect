/* Synthetic DEV Redis integration. Refuses populated databases on preparation. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')
const ts = require('typescript')
const Redis = require('ioredis')
const { proto } = require('zapo-js')
assert.equal(process.env.REDIS_URL, 'redis://127.0.0.1:6379', 'isolated loopback Redis required')
const OWNER = 'synthetic-message-copy-dev-only-v1'
const compiled = ts.transpileModule(fs.readFileSync('/app/copy-prototype.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const localModule = new Module('/app/copy-prototype.js', module)
localModule.paths = module.paths
localModule._compile(compiled, '/app/copy-prototype.js')
const codec = localModule.exports
const hash = value => createHash('sha256').update(value).digest('hex')
const encode = value => Buffer.from(proto.WebMessageInfo.encode(value).finish())

async function main() {
  const redis = new Redis(process.env.REDIS_URL)
  const mode = process.env.COPY_PROBE_ACTION || 'verify'
  if (mode === 'prepare') {
    assert.equal(await redis.dbsize(), 0, 'refusing to prepare a non-empty database')
    await redis.set('copy-probe:owner', OWNER)
  }
  assert.equal(await redis.get('copy-probe:owner'), OWNER, 'wrong test database')
  const legacy = require(path.resolve('dist/src/services/redis'))
  const { getDataStoreRedis } = require(path.resolve('dist/src/services/data_store_redis'))
  const { defaultConfig } = require(path.resolve('dist/src/services/config'))
  const phone = '5511888888888'
  const cache = await getDataStoreRedis(phone, { ...defaultConfig, provider: 'zapo', useRedis: true })
  if (mode === 'prepare') {
    const manifest = []
    for (let i = 0; i < 48; i++) {
      const provider = `SYNTHETIC-PROVIDER-${i}`, uno = `uno-public-${i}`
      const thread = i % 3 === 0 ? '120363000000000@g.us' : '123@lid'
      const message = i % 4 === 0 ? { conversation: 'Synthetic text '.repeat(700) }
        : { [`${['image', 'video', 'document'][i % 3]}Message`]: { caption: 'Synthetic caption '.repeat(700),
          mediaKey: Buffer.alloc(32, 1), fileSha256: Buffer.alloc(32, 2), fileEncSha256: Buffer.alloc(32, 3), directPath: '/synthetic-only' } }
      message.messageContextInfo = { messageSecret: Buffer.alloc(32, 4) }
      const stamp = Math.floor(Date.now() / 1000)
      const envelope = { key: { id: provider, remoteJid: thread, fromMe: i % 2 === 0, ...(thread.endsWith('@g.us') ? { participant: '456@lid' } : {}) },
        messageTimestamp: stamp, pushName: 'Synthetic sender', message }
      assert.equal(await cache.setUnoId(provider, uno), uno)
      await cache.setKey(provider, envelope.key); await cache.setKey(uno, envelope.key)
      await cache.setMessage(thread, envelope)
      const oldKey = `unoapi-message:${phone}:${thread}:${provider}`
      const stored = await redis.get(oldKey), ttl = await redis.pttl(oldKey)
      const nativeKey = `unoapi:zapo:msg:${phone}:${provider}`
      await redis.hset(nativeKey, { id: provider, thread_jid: thread, from_me: envelope.key.fromMe ? '1' : '0', timestamp_ms: String(stamp * 1000) })
      await redis.set(nativeKey + ':message_bytes', Buffer.from(proto.Message.encode(message).finish()))
      const native = { id: provider, threadJid: thread, fromMe: envelope.key.fromMe, timestampMs: stamp * 1000, messageBytes: proto.Message.encode(message).finish() }
      const now = Date.now()
      const result = codec.proposeMessageCopy(stored, native, { phone, thread, providerId: provider, now, legacyTtlMs: 3600000, nativeTtlMs: 3600000, legacyExpiresAt: now + ttl })
      assert.equal(result.compacted, true)
      const packedKey = `copy-probe:compact:${provider}`
      await redis.set(packedKey, result.stored, 'PX', ttl)
      manifest.push({ provider, uno, thread, oldKey, packedKey, nativeKey, expectedHash: hash(encode(await cache.loadMessageExact(thread, provider))) })
    }
    const [raceA, raceB] = await Promise.all([cache.setUnoId('SYNTHETIC-RACE', 'uno-race-a'), cache.setUnoId('SYNTHETIC-RACE', 'uno-race-b')])
    assert.equal(raceA, raceB)
    assert.equal(await cache.loadProviderId(raceA), 'SYNTHETIC-RACE')
    await redis.set('copy-probe:manifest', JSON.stringify(manifest))
    console.log(JSON.stringify({ stage: 'prepare', syntheticRecords: manifest.length, concurrentIdMapping: 'PASS', realSends: 0 }))
  } else {
    const manifest = JSON.parse(await redis.get('copy-probe:manifest'))
    let oldMemory = 0, compactMemory = 0, nativeReads = 0, fallbackReads = 0, checked = 0
    for (const item of manifest) {
      assert.equal(await cache.loadUnoId(item.provider), item.uno)
      assert.equal(await cache.loadProviderId(item.uno), item.provider)
      assert.equal((await cache.loadKey(item.uno)).id, item.provider)
      const old = await cache.loadMessageExact(item.thread, item.provider)
      assert.equal(hash(encode(old)), item.expectedHash)
      const stored = await redis.get(item.packedKey)
      assert.ok((await redis.pttl(item.packedKey)) <= (await redis.pttl(item.oldKey)) + 200)
      const data = await redis.hgetall(item.nativeKey), binary = await redis.getBuffer(item.nativeKey + ':message_bytes')
      const native = { id: data.id, threadJid: data.thread_jid, fromMe: data.from_me === '1', timestampMs: Number(data.timestamp_ms), messageBytes: binary }
      const scope = { phone, thread: item.thread, now: Date.now() }
      const restored = codec.readMessageCopy(stored, native, scope)
      assert.equal(restored.source, 'native'); nativeReads++
      assert.equal(hash(encode(restored.message)), item.expectedHash)
      // Actual Redis deletion is restricted to this isolated synthetic database.
      await redis.del(item.nativeKey, item.nativeKey + ':message_bytes')
      const fallback = codec.readMessageCopy(await redis.get(item.packedKey), null, scope)
      assert.equal(fallback.source, 'compressed_fallback'); fallbackReads++
      assert.equal(hash(encode(fallback.message)), item.expectedHash)
      assert.equal(await cache.loadUnoId(item.provider), item.uno)
      assert.equal(await cache.loadProviderId(item.uno), item.provider)
      const secret = await cache.findMessageWithSecret(item.provider, [item.thread])
      assert.equal(secret.message.messageContextInfo.messageSecret.length, 32)
      oldMemory += Number(await redis.memory('USAGE', item.oldKey))
      compactMemory += Number(await redis.memory('USAGE', item.packedKey))
      checked++
    }
    console.log(JSON.stringify({ stage: 'verify-after-restart', checked, nativeReads, fallbackReads,
      oldMemory, compactMemory, syntheticCopyMemorySavingPercent: 100 * (1 - compactMemory / oldMemory),
      ids: 'PASS', envelopes: 'PASS', retention: 'PASS', secrets: 'PASS', realSends: 0, externalNetwork: false }))
  }
  await redis.quit()
}
main().then(() => process.exit(0)).catch(error => { console.error(error.name, error.message); process.exit(1) })
