/* Synthetic isolated Valkey test. Refuses a nonempty DB or any non-loopback target. */
const fs = require('node:fs')
const crypto = require('node:crypto')
const Module = require('node:module')
const assert = require('node:assert/strict')
const ts = require('typescript')
const Redis = require('ioredis')
const { DatabaseSync } = require('node:sqlite')

function compile(path, overrides = {}) {
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const mod = new Module(path, module); mod.paths = module.paths; mod.require = id => overrides[id] || require(id); mod._compile(source, path); return mod.exports
}
const types = compile('/app/probe-types.ts')
const { cleanRedisSource, CLEAN_SOURCE_BATCH_LUA, sourceFingerprintsDigest } = compile('/app/probe-source-cleanup.ts', { './types': types })

async function main() {
  const url = process.env.CLEANUP_PROBE_REDIS_URL || 'redis://127.0.0.1:6379'
  if (url !== 'redis://127.0.0.1:6379') throw new Error('isolated_loopback_only')
  const redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 10000 })
  const sql = new DatabaseSync(':memory:')
  try {
    if (await redis.dbsize() !== 0) throw new Error('isolated_empty_database_required')
    const marker = crypto.randomUUID(); await redis.set('probe-owner', marker)
    const phone = '999123456789', prefix = 'unoapi:zapo:', backupId = crypto.randomUUID(), storageId = crypto.randomUUID(), token = crypto.randomUUID()
    const storage = { backend: 'sqlite', storageId, owner: 'synthetic_worker', generation: 4, state: 'offline', fixture: true }
    const manifest = { id: backupId, phone, storageId, generation: 4, status: 'ready' }
    await redis.set(`unoapi-config:${phone}`, JSON.stringify({ server: storage.owner, autoConnect: false, sessionStorage: storage }))
    await redis.set(`unoapi-session-storage:backup:${backupId}`, JSON.stringify(manifest))
    const leaseKey = `unoapi-lease:zapo-session:${phone}`; await redis.set(leaseKey, token, 'PX', 60000)
    sql.exec('CREATE TABLE uno_storage_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE uno_source_fingerprints(key TEXT PRIMARY KEY,sha1 TEXT,expires_at INTEGER,captured_at INTEGER); CREATE TABLE copied_messages(key TEXT PRIMARY KEY,value BLOB)')
    sql.prepare('INSERT INTO uno_storage_meta VALUES (?,?)').run('phone', phone)
    const db = { get: (q, a = []) => sql.prepare(q).get(...a), all: (q, a = []) => sql.prepare(q).all(...a) }
    const names = ['unchanged', 'mutated', 'ttl_extended']
    for (const name of names) {
      const key = `unoapi-message:${phone}:jid:${name}`, bytes = Buffer.from(`synthetic-${name}`)
      await redis.set(key, bytes, 'PX', 30000)
      const ttl = await redis.pttl(key), dump = await redis.dumpBuffer(key)
      sql.prepare('INSERT INTO uno_source_fingerprints VALUES (?,?,?,?)').run(key, crypto.createHash('sha1').update(dump).digest('hex'), Date.now() + ttl, Date.now())
      sql.prepare('INSERT INTO copied_messages VALUES (?,?)').run(key, bytes)
    }
    const foreign = `unoapi-message:${phone}0:jid:foreign`; await redis.set(foreign, 'foreign-preserved')
    await redis.set(`unoapi-message:${phone}:jid:mutated`, 'changed-after-snapshot', 'PX', 30000)
    await redis.pexpire(`unoapi-message:${phone}:jid:ttl_extended`, 120000)
    const digest = sourceFingerprintsDigest(db)
    const lease = { key: leaseKey, token, assertOwned: async () => { assert.equal(await redis.get(leaseKey), token) } }
    // The snapshot digest is the verification predicate; upload/crypto roundtrip has separate SQLite integration tests.
    const result = await cleanRedisSource({ redis, database: db, phone, storage, prefix, body: { confirm: true, backupId, generation: 4 }, lease, verifyBackup: async (_manifest, expected) => expected === digest })
    assert.equal(result.deleted, 1); assert.equal(result.skippedMutated, 1); assert.equal(result.skippedTtl, 1)
    assert.equal(await redis.exists(`unoapi-message:${phone}:jid:unchanged`), 0)
    assert.equal(await redis.get(foreign), 'foreign-preserved'); assert.equal(await redis.get('probe-owner'), marker)
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM copied_messages').get().n, 3)
    assert.ok(result.deletedKeyBytes > 0)
    // Stale generations and stolen leases must reject atomically, not delete an earlier key in the batch.
    const row = sql.prepare('SELECT key,sha1,expires_at FROM uno_source_fingerprints WHERE key LIKE ?').get('%mutated')
    const args = [4, `unoapi-config:${phone}`, leaseKey, `unoapi-session-storage:backup:${backupId}`, row.key, '3', storageId, storage.owner, token, backupId, phone, prefix, JSON.stringify([{ key: row.key, sha1: row.sha1, expiresAt: row.expires_at }])]
    await assert.rejects(redis.eval(CLEAN_SOURCE_BATCH_LUA, ...args), /configuration_changed/)
    args[5] = '4'; await redis.set(leaseKey, 'another-worker')
    await assert.rejects(redis.eval(CLEAN_SOURCE_BATCH_LUA, ...args), /lease_lost/)
    assert.equal(await redis.get(`unoapi-message:${phone}:jid:mutated`), 'changed-after-snapshot')
    console.log(JSON.stringify({ synthetic: true, externalSends: 0, results: result, copiedMessagesPreserved: 3, staleGenerationRejected: true, stolenLeaseRejected: true }))
  } finally { sql.close(); await redis.quit() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
