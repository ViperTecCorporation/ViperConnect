/* Dedicated disposable Redis + synthetic session only; never the live control plane. */
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const { mkdtemp, readFile, rm, realpath } = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  if (process.env.STORAGE_DR_CONFIRM !== 'synthetic-lab-only' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.STORAGE_BUCKET_NAME !== 'viperconnect-lab' || process.env.STORAGE_DR_REDIS_URL !== 'redis://viper-storage-dr-20261108:6379/0') throw Error('isolated_dr_confirmation_required')
  const { createClient } = app('@redis/client'), Redis = app('ioredis')
  const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
  const { restoreStandaloneSession } = app('/app/dist/src/services/session_storage/standalone_recovery.js')
  const { isSessionSourceCleanupKey } = app('/app/dist/src/services/session_storage/source_cleanup.js')
  const { openPreparedSessionDatabase } = app('/app/dist/src/services/session_storage/database.js')
  const { validateLiveIdMappings } = app('/app/dist/src/services/session_storage/id_validation.js')
  const phone = process.env.STORAGE_DR_FIXTURE_PHONE
  assert.match(phone || '', /^999010\d{7}$/)
  const source = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }), redis = createClient({ url: process.env.STORAGE_DR_REDIS_URL })
  redis.on('error', () => {})
  let directory
  try {
    await redis.connect(); assert.equal(await redis.dbSize(), 0)
    const configuration = JSON.parse(await source.get('unoapi-config:' + phone) || '{}')
    assert.equal(configuration.name, 'Synthetic storage E2E'); assert.equal(configuration.sessionStorage.fixture, true); assert.equal(configuration.autoConnect, false)
    assert.equal(await source.exists('unoapi-lease:zapo-session:' + phone), 0); assert.equal(await source.exists('unoapi-session-storage:task:lock:' + phone), 0)
    const manifest = JSON.parse(await source.get('unoapi-session-storage:last-backup:' + phone)); assert.equal(manifest.phone, phone)
    directory = await mkdtemp(join(process.env.SESSION_STORAGE_ROOT, 'synthetic-dr-'))
    const result = await restoreStandaloneSession({ phone, backupId: manifest.id, confirm: true, confirmOriginOffline: true }, {
      objects: createBackupObjects(), redis, baseStore: directory, owner: 'dr-isolated', password: (await readFile(process.env.SESSION_STORAGE_BACKUP_KEY_FILE, 'utf8')).trim(),
      destinationEmpty: async (value, owned) => {
        for await (const keys of redis.scanIterator({ MATCH: '*' + value + '*', COUNT: 100 })) {
          for (const key of Array.isArray(keys) ? keys : [keys]) if (!owned.includes(key) && (key === 'unoapi-config:' + value || key === 'unoapi-status:' + value || isSessionSourceCleanupKey(key, value, 'unoapi:zapo:'))) return false
        }
        return true
      },
      lease: value => {
        const key = 'unoapi-lease:zapo-session:' + value, token = randomUUID()
        return { ownership: () => ({ key, token }), acquire: async () => await redis.set(key, token, { NX: true, PX: 120000 }) === 'OK',
          assertOwned: async () => { assert.equal(await redis.get(key), token); await redis.pExpire(key, 120000) },
          release: async () => { if (await redis.get(key) === token) return redis.del(key) },
        }
      },
    })
    assert.equal(result.autoConnect, false); assert.equal(result.connected, false); assert.equal(result.replayed, false); assert.equal(result.storage.fixture, true)
    const restored = JSON.parse(await redis.get('unoapi-config:' + phone)); assert.equal(restored.overrideWebhooks, true); assert.equal(restored.autoConnect, false)
    assert.ok(restored.webhooks.every(hook => hook.enabled === false)); assert.equal(await redis.get('unoapi-status:' + phone), 'offline')
    const db = openPreparedSessionDatabase(join(directory, 'session-storage', result.storage.storageId, 'session.sqlite'))
    try { assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok'); assert.equal(validateLiveIdMappings(db, phone), true); assert.equal(db.get('SELECT COUNT(*) AS n FROM mailbox_messages').n, 320) } finally { db.close() }
    await assert.rejects(restoreStandaloneSession({ phone, backupId: manifest.id, confirm: true, confirmOriginOffline: true }, {
      objects: createBackupObjects(), redis, baseStore: directory, owner: 'dr-isolated', password: (await readFile(process.env.SESSION_STORAGE_BACKUP_KEY_FILE, 'utf8')).trim(),
      destinationEmpty: async () => false, lease: () => ({ acquire: async () => true, ownership: () => ({ key: 'unoapi-lease:zapo-session:' + phone, token: randomUUID() }), assertOwned: async () => {}, release: async () => {} }),
    }), /destination_exists/)
    console.log(JSON.stringify({ event: 'standalone_redis_loss_recovery_passed', priorRedisCatalogue: false, s3ManifestAndArchive: true, messages: 320, bidirectionalIds: true,
      offline: true, webhooksDisabled: true, overwriteBlocked: true, realSends: 0, productionWrites: 0 }))
  } finally {
    if (redis.isOpen) await redis.quit(); await source.quit()
    if (directory) { const root = await realpath(process.env.SESSION_STORAGE_ROOT), target = await realpath(directory); assert.ok(target.startsWith(root + sep)); assert.ok(target.startsWith(resolve(root, 'synthetic-dr-'))); await rm(target, { recursive: true, force: true }) }
  }
}
main().catch(error => { console.error(JSON.stringify({ event: 'standalone_dr_failed', code: error.code || error.message })); process.exitCode = 1 })
