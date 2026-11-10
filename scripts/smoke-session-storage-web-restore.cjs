/* Real DEV HTTP/AMQP/SQLite/S3, synthetic absent destination only. No WhatsApp connection. */
const { createRequire } = require('node:module')
const { randomUUID, randomInt } = require('node:crypto')
const { resolve, sep } = require('node:path')
const { realpath, rm } = require('node:fs/promises')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  assert.equal(process.env.STORAGE_WEB_RESTORE_CONFIRM, 'synthetic-lab-only')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
  assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  redis.on('error', () => {})
  const resume = process.env.STORAGE_WEB_RESTORE_RESUME_PHONE
  if (resume) assert.match(resume, /^999014\d{7}$/)
  const phone = resume || '999014' + randomInt(1000000, 9999999), configKey = `unoapi-config:${phone}`
  let marker = randomUUID(), sourceId = randomUUID()
  if (resume) {
    const existing = JSON.parse(await redis.get(configKey) || '{}')
    assert.equal(existing.name, 'Synthetic web restore ' + existing.storageWebRestore)
    assert.equal(existing.sessionStorage?.fixture, true); assert.equal(existing.autoConnect, false)
    assert.match(existing.storageWebRestore || '', /^[a-f0-9-]{36}$/)
    marker = existing.storageWebRestore; sourceId = existing.sessionStorage.storageId
  }
  const ownedStorageIds = new Set([sourceId]), aliasIds = new Set(), backupIds = new Set()
  const { openSessionDatabase, closeAllSessionDatabases } = app('/app/dist/src/services/session_storage/database.js')
  const { sqliteSdkConnection } = app('/app/dist/src/services/session_storage/native_migration.js')
  const { createSqliteStore, ensureSqliteMigrations } = app('@zapo-js/store-sqlite')
  const { proto } = app('zapo-js')
  const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
  const objects = createBackupObjects(), headers = { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN }
  const prefix = `backups/session-storage/${phone}/`, sourceMarker = 'Synthetic web restore ' + marker
  let created = false, sourceRemoved = false, stage = 'preflight', cleanup = false, success = false, requests = 0
  const initial = { provider: 'zapo', server: 'mobile_lab', useRedis: true, useS3: true, autoConnect: false,
    name: sourceMarker, webhooks: [], overrideWebhooks: true, sessionWebhook: '', storageWebRestore: marker,
    sessionStorage: { backend: 'sqlite', owner: 'mobile_lab', storageId: sourceId, generation: 1, state: 'offline', fixture: true } }
  async function http(path, options = {}, expected = 200) {
    requests++
    const response = await fetch('http://web:9876' + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, expected, 'web_restore_http_' + response.status)
    return response
  }
  async function poll(id, global, expected = 'ready') {
    const end = Date.now() + 120000
    while (Date.now() < end) {
      const task = await (await http(global ? `/manager/storage/restores/${phone}/${id}` : `/v15.0/${phone}/storage/tasks/${id}`)).json()
      if (task.status !== 'running') { assert.equal(task.status, expected, 'web_restore_task_' + (task.error || task.status)); return task }
      await new Promise(done => setTimeout(done, 200))
    }
    throw Error('web_restore_poll_timeout')
  }
  try {
    if (!resume) {
      assert.equal(await redis.exists(configKey, `unoapi-status:${phone}`), 0)
      assert.equal(await redis.set(configKey, JSON.stringify(initial), 'NX'), 'OK')
    }
    created = true
    await redis.sadd('unoapi-sessions:index', phone); await redis.set(`unoapi-status:${phone}`, 'offline')
    const db = openSessionDatabase(phone, { ...initial, baseStore: process.env.SESSION_STORAGE_ROOT }, { create: true })
    const connection = sqliteSdkConnection(db)
    await ensureSqliteMigrations(connection, ['mailbox'])
    const sdk = createSqliteStore({ connection }), now = Date.now(), expiry = now + 3600000, count = 128
    for (let i = 0; i < count; i++) {
      const provider = `WEB_RESTORE_PROVIDER_${i}`, uno = `WEB_RESTORE_UNO_${i}`
      await sdk.stores.messages(phone).upsert({ id: provider, threadJid: '111111111@lid', fromMe: false,
        timestampMs: now - 60000 + i, messageBytes: proto.Message.encode({ conversation: 'Synthetic restore validation' }).finish() })
      db.putValue(`unoapi-id:${phone}:${provider}`, uno, { encoding: 'string', expiresAt: expiry })
      db.putValue(`unoapi-id_rev:${phone}:${uno}`, provider, { encoding: 'string', expiresAt: expiry })
    }
    stage = 'backup'
    const accepted = await (await http(`/v15.0/${phone}/storage/backups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }, 202)).json()
    const backup = (await poll(accepted.id, false)).result
    backupIds.add(backup.id)
    assert.equal(backup.protection, 'none')
    stage = 'backup-library'
    const library = await (await http(`/manager/storage/${phone}/backups`)).json()
    assert.equal(library.latest.id, backup.id); assert.ok(library.slots.some(slot => slot.id === backup.id))
    const archiveResponse = await http(`/manager/storage/${phone}/backups/latest/download`)
    assert.match(archiveResponse.headers.get('content-disposition') || '', /attachment/)
    const archive = Buffer.from(await archiveResponse.arrayBuffer())
    assert.ok(archive.length > 0 && archive.length < 10 * 1024 * 1024)
    stage = 'existing-destination-refused'
    const path = `/manager/storage/restore-upload?phone=${phone}&owner=mobile_lab&confirmOriginOffline=true&mode=offline`
    const upload = body => ({ method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }, body })
    await http(path, upload(archive), 409)
    const owners = await (await http('/manager/storage/workers')).json()
    assert.ok(owners.workers.some(worker => worker.owner === 'mobile_lab' && worker.available === true))
    const resolved = JSON.parse(await redis.get(configKey))
    if (resolved.webhookForward?.businessAccountId) aliasIds.add(resolved.webhookForward.businessAccountId)
    assert.equal(resolved.storageWebRestore, marker); assert.equal(resolved.sessionStorage.fixture, true)
    assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`, `unoapi-session-storage:task:lock:${phone}`), 0)
    // Remove only this fixture's catalogue/status to simulate a fresh destination.
    assert.equal(Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('DEL',KEYS[1],KEYS[2]);redis.call('SREM',KEYS[3],ARGV[2]);redis.call('PUBLISH','unoapi-config:update',ARGV[2]);return 1", 3,
      configKey, `unoapi-status:${phone}`, 'unoapi-sessions:index', JSON.stringify(resolved), phone)), 1)
    sourceRemoved = true
    stage = 'truncated-upload'
    const bad = await (await http(path, upload(archive.subarray(0, archive.length - 100)), 202)).json()
    await poll(bad.id, true, 'failed'); assert.equal(await redis.exists(configKey), 0)
    stage = 'restore-new-session'
    const job = await (await http(path, upload(archive), 202)).json()
    assert.equal(job.phone, phone)
    const done = await poll(job.id, true)
    assert.equal(done.result.restored, true); assert.equal(done.result.connected, false); assert.equal(done.result.replayed, false)
    assert.equal(done.result.autoConnect, false); assert.equal(done.result.webhooksEnabled, false)
    const restored = JSON.parse(await redis.get(configKey))
    assert.equal(restored.storageWebRestore, marker); assert.equal(restored.name, sourceMarker)
    assert.equal(restored.sessionStorage.fixture, true); assert.equal(restored.autoConnect, false)
    assert.equal(restored.sessionStorage.owner, 'mobile_lab'); assert.notEqual(restored.sessionStorage.storageId, sourceId)
    ownedStorageIds.add(restored.sessionStorage.storageId)
    if (restored.webhookForward?.businessAccountId) aliasIds.add(restored.webhookForward.businessAccountId)
    assert.equal(await redis.get(`unoapi-status:${phone}`), 'offline'); assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`), 0)
    const destination = openSessionDatabase(phone, { ...restored, baseStore: process.env.SESSION_STORAGE_ROOT })
    assert.equal(destination.get('PRAGMA quick_check').quick_check, 'ok')
    assert.equal(Number(destination.get('SELECT COUNT(*) n FROM mailbox_messages WHERE session_id=?', [phone]).n), count)
    const { validateLiveIdMappings } = app('/app/dist/src/services/session_storage/id_validation.js')
    assert.equal(validateLiveIdMappings(destination, phone), true)
    stage = 'duplicate-refused'
    await http(path, upload(archive), 409)
    const page = await (await http(`/v15.0/${phone}/conversations/111111111%40lid/messages?limit=100`)).json()
    assert.equal(page.data.length, 100); assert.equal(page.has_more, true)
    success = true
    console.log(JSON.stringify({ webRestorePassed: true, requests, messages: count, latestDownload: true, weeklyLibrary: true,
      freshDestination: true, priorCatalogueAbsent: true, incompleteRejected: true, overwriteRejected: true,
      restoredOffline: true, webhooksDisabled: true, idsConsistent: true, noConnectOrReplay: true, realSends: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ webRestorePassed: false, stage, error: error.message }))
    throw error
  } finally {
    if (created) {
      const raw = await redis.get(configKey), cfg = raw && JSON.parse(raw)
      assert.ok(!cfg || cfg.storageWebRestore === marker && cfg.sessionStorage?.fixture === true && cfg.autoConnect === false, 'foreign_cleanup_refused')
      assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`), 0)
      if (cfg?.sessionStorage?.storageId) ownedStorageIds.add(cfg.sessionStorage.storageId)
      // Preserve failed or active operations for inspection, rather than deleting their evidence.
      if (success) {
        assert.equal(await redis.exists(`unoapi-session-storage:standalone-job:${phone}`, `unoapi-session-storage:task:lock:${phone}`), 0)
        closeAllSessionDatabases()
        for await (const key of objects.keys(prefix)) { assert.ok(key.startsWith(prefix)); await objects.remove(key) }
        const root = await realpath(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage'))
        for (const id of ownedStorageIds) { assert.match(id, /^[a-f0-9-]{36}$/); const directory = resolve(root, id); assert.ok(directory.startsWith(root + sep)); assert.equal(await realpath(directory), directory); await rm(directory, { recursive: true, force: true }) }
        const keys = new Set([configKey, `unoapi-status:${phone}`])
        let cursor = '0'
        do { const page = await redis.scan(cursor, 'MATCH', `*${phone}*`, 'COUNT', 500); cursor = page[0]
          for (const key of page[1]) if (key.startsWith('unoapi-') && (key.endsWith(':' + phone) || key.includes(':' + phone + ':'))) keys.add(key)
        } while (cursor !== '0')
        for (const id of backupIds) keys.add(`unoapi-session-storage:backup:${id}`)
        for (const id of aliasIds) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, `unoapi-meta:business_account_id:${id}`, phone)
        if (keys.size) await redis.unlink(...keys)
        await redis.srem('unoapi-sessions:index', phone); await redis.publish('unoapi-config:update', phone)
        cleanup = true
      }
    }
    await redis.quit()
    console.log(JSON.stringify({ webRestoreCleanup: cleanup, preservedForInspection: created && !cleanup, sourceCatalogueRemoved: sourceRemoved }))
  }
}
main().then(() => process.exit(0)).catch(() => process.exit(1))
