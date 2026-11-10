/* Explicitly isolated DEV synthetic CRUD: never writes a real session or sends WhatsApp. */
const assert = require('node:assert/strict')
const { randomUUID, randomInt } = require('node:crypto')
const { createRequire } = require('node:module')
const { resolve, sep } = require('node:path')
const { realpath, rm } = require('node:fs/promises')
const app = createRequire('/app/package.json')
async function main() {
  assert.equal(process.env.STORAGE_EXPLORER_CONFIRM, 'synthetic-lab-only')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab'); assert.equal(process.env.REDIS_URL, 'redis://redis:6379'); assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
  const phone = '999017' + randomInt(1000000, 9999999), marker = randomUUID(), storageId = randomUUID(), prefix = `backups/session-storage/${phone}/`
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  const { openSessionDatabase, closeAllSessionDatabases } = app('/app/dist/src/services/session_storage/database.js')
  const { sqliteSdkConnection } = app('/app/dist/src/services/session_storage/native_migration.js')
  const { ensureSqliteMigrations } = app('@zapo-js/store-sqlite')
  const objects = app('/app/dist/src/services/session_storage/backup_objects.js').createBackupObjects()
  const configKey = `unoapi-config:${phone}`, backupIds = new Set()
  const config = { provider: 'zapo', server: 'mobile_lab', useRedis: true, useS3: true, autoConnect: false, name: 'Synthetic explorer CRUD', webhooks: [], overrideWebhooks: true,
    storageExplorerFixture: marker, sessionStorage: { backend: 'sqlite', storageId, owner: 'mobile_lab', generation: 1, state: 'offline', fixture: true } }
  let created = false, success = false, requests = 0
  const path = `/v15.0/${phone}/storage/explorer`
  async function http(suffix = '', body, expected = 200) {
    const r = await fetch('http://web:9876' + path + suffix, { headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) })
    requests++; const result = await r.json(); assert.equal(r.status, expected, result.error || 'http_status'); if (result.backupId) backupIds.add(result.backupId); return result
  }
  try {
    assert.equal(await redis.exists(configKey), 0)
    await redis.set(configKey, JSON.stringify(config), 'NX'); created = true
    await redis.set(`unoapi-status:${phone}`, 'offline')
    const db = openSessionDatabase(phone, { ...config, baseStore: process.env.SESSION_STORAGE_ROOT }, { create: true })
    await ensureSqliteMigrations(sqliteSdkConnection(db), ['mailbox'])
    assert.ok((await http()).tables.some(t => t.name === 'uno_kv' && t.editable))
    await http('?table=auth_credentials', undefined, 403)
    await http('?sql=DELETE', undefined, 400)
    const values = { key: `unoapi-contact-name:${phone}:synthetic`, value: { utf8: 'before' }, encoding: 'utf8', expires_at: null }
    await http('', { action: 'create', table: 'uno_kv', generation: 1, confirm: true, values })
    let page = await http('?table=uno_kv&search=synthetic'), row = page.rows[0]
    assert.equal(row.cells.value.value, 'before')
    const update = { action: 'update', table: 'uno_kv', generation: 1, confirm: true, rowId: row.id, etag: row.etag, values: { value: { utf8: 'after' } } }
    await http('', update)
    await http('', update, 409)
    row = (await http('?table=uno_kv&search=synthetic')).rows[0]; assert.equal(row.cells.value.value, 'after')
    await redis.set(`unoapi-status:${phone}`, 'online')
    await http('', { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: row.id, etag: row.etag }, 409)
    await redis.set(`unoapi-status:${phone}`, 'offline')
    await http('', { action: 'delete', table: 'uno_kv', generation: 1, confirm: true, rowId: row.id, etag: row.etag })
    assert.equal((await http('?table=uno_kv&search=synthetic')).rows.length, 0)
    await http('', { action: 'create', table: 'uno_kv', generation: 1, confirm: true, values: { key: `unoapi-id:${phone}:PROVIDER`, value: { utf8: 'UNO' }, encoding: 'utf8' } })
    assert.equal(db.getValue(`unoapi-id_rev:${phone}:UNO`).toString(), 'PROVIDER')
    assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok')
    assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`), 0)
    success = true; console.log(JSON.stringify({ explorerCrudPassed: true, requests, verifiedBackups: backupIds.size, protectedTables: true, staleWritesRejected: true, onlineWritesRejected: true, idPairsConsistent: true, whatsappSends: 0 }))
  } finally {
    if (created && success) {
      const current = JSON.parse(await redis.get(configKey)); assert.equal(current.storageExplorerFixture, marker); assert.equal(current.sessionStorage.fixture, true)
      assert.equal(await redis.exists(`unoapi-session-storage:task:lock:${phone}`), 0)
      for await (const key of objects.keys(prefix)) {
        const id = key.slice(prefix.length).match(/^([a-f0-9-]{36})\.viperstorage/)?.[1]; if (id) backupIds.add(id)
        await objects.remove(key)
      }
      closeAllSessionDatabases()
      const root = await realpath(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage')), dir = resolve(root, storageId)
      assert.ok(dir.startsWith(root + sep)); assert.equal(await realpath(dir), dir); await rm(dir, { recursive: true })
      let cursor = '0'; const keys = new Set([configKey, `unoapi-status:${phone}`])
      do { const page = await redis.scan(cursor, 'MATCH', `unoapi-*${phone}*`, 'COUNT', 500); cursor = page[0]; for (const key of page[1]) if (key.endsWith(':' + phone) || key.includes(':' + phone + ':')) keys.add(key) } while (cursor !== '0')
      for (const id of backupIds) keys.add(`unoapi-session-storage:backup:${id}`)
      if (current.webhookForward?.businessAccountId) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, `unoapi-meta:business_account_id:${current.webhookForward.businessAccountId}`, phone)
      await redis.unlink(...keys); await redis.srem('unoapi-sessions:index', phone); await redis.publish('unoapi-config:update', phone)
      console.log(JSON.stringify({ syntheticCleanup: true }))
    } else if (created) console.log(JSON.stringify({ preservedSyntheticFixture: phone, storageId }))
    await redis.quit()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1) })
