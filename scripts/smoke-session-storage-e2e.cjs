/* DEV only: real HTTP/AMQP/Redis/SQLite/S3; synthetic fixture, no WhatsApp client. */
const { createRequire } = require('node:module')
const { randomUUID, randomInt } = require('node:crypto')
const { resolve, sep } = require('node:path')
const { rm, realpath } = require('node:fs/promises')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  if (process.env.STORAGE_E2E_CONFIRM !== 'synthetic-lab-only' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.STORAGE_BUCKET_NAME !== 'viperconnect-lab' || process.env.REDIS_URL !== 'redis://redis:6379') throw Error('isolated_lab_confirmation_required')
  const Redis = app('ioredis'), { proto } = app('zapo-js'), { createRedisStore } = app('@zapo-js/store-redis')
  const { closeAllSessionDatabases, openSessionDatabase } = app('/app/dist/src/services/session_storage/database.js')
  const { getConfigRedis } = app('/app/dist/src/services/config_redis.js')
  const { configs } = app('/app/dist/src/services/config.js')
  const { SessionSqliteBackups } = app('/app/dist/src/services/session_storage/backup.js')
  const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
  const { backupWeekday } = app('/app/dist/src/services/session_storage/backup_slots.js')
  const backupObjects = createBackupObjects()
  // Local verifier has no key configured; HTTP worker must also create plain archives.
  delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  const { PRIVATE_REDIS_FENCE_LUA } = app('/app/dist/src/services/session_storage/private_state.js')
  const phone = '999010' + String(randomInt(1000000, 9999999)), marker = randomUUID()
  const configKey = `unoapi-config:${phone}`, direct = '111111111@lid', group = '111111111-222222222@g.us'
  const initial = { provider: 'zapo', server: 'mobile_lab', useRedis: true, useS3: true, autoConnect: false,
    name: 'Synthetic storage E2E', webhooks: [], overrideWebhooks: true, sessionWebhook: '',
    sessionStorage: { backend: 'redis', owner: 'mobile_lab', storageId: randomUUID(), generation: 1, state: 'offline', fixture: true }, storageE2E: marker }
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
  const ownedStorageIds = new Set(), objectKeys = new Set(), manifestIds = new Set(), businessAccountIds = new Set()
  let success = false, cleanupComplete = false, requests = 0, created = false
  async function fresh() { configs.delete(phone); const config = await getConfigRedis(phone); if (config.webhookForward?.businessAccountId) businessAccountIds.add(config.webhookForward.businessAccountId); return { ...config, baseStore: process.env.SESSION_STORAGE_ROOT } }
  async function http(path, body, expected = 200) {
    const response = await fetch('http://web:9876' + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    requests++; assert.equal(response.status, expected, 'unexpected_http_status'); return response.json()
  }
  const storagePath = `/v15.0/${phone}/storage`
  async function task(path, body) {
    return poll(await http(path, body, 202))
  }
  async function poll(accepted) {
    assert.equal(accepted.phone, phone)
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      const current = await http(`${storagePath}/tasks/${accepted.id}`)
      if (current.status === 'ready') return current.result
      if (current.status !== 'running') throw Error('synthetic_task_failed:' + (current.error || current.status))
      await new Promise(done => setTimeout(done, 250))
    }
    throw Error('synthetic_task_timeout')
  }
  async function rememberBackup(id) {
    const raw = await redis.get(`unoapi-session-storage:backup:${id}`); assert.ok(raw, 'backup_manifest_missing')
    const manifest = JSON.parse(raw); assert.equal(manifest.phone, phone)
    assert.equal(manifest.objectKey, `backups/session-storage/${phone}/${id}.viperstorage`)
    manifestIds.add(id); objectKeys.add(manifest.objectKey); objectKeys.add(manifest.objectKey + '.manifest.json')
    objectKeys.add(`backups/session-storage/${phone}/slots/${backupWeekday(manifest.createdAt, 'America/Cuiaba')}.json`)
    return manifest
  }
  async function verifyPages() {
    const conversations = await http(`/v15.0/${phone}/conversations?limit=10`)
    assert.equal(conversations.data.length, 2); assert.ok(conversations.data.some(c => c.kind === 'group'))
    let count = 0
    for (const conversation of conversations.data) {
      const seen = new Set(); let cursor
      do {
        const page = await http(`/v15.0/${phone}/conversations/${encodeURIComponent(conversation.id)}/messages?limit=37${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
        for (const message of page.data) { assert.ok(!seen.has(message.id), 'duplicate_message'); seen.add(message.id); assert.ok(message.reply_id.startsWith('E2E_UNO_')) }
        cursor = page.has_more ? page.next_cursor : undefined
      } while (cursor)
      count += seen.size
    }
    assert.equal(count, 320); return count
  }
  try {
    assert.equal(await redis.set(configKey, JSON.stringify(initial), 'NX'), 'OK', 'fixture_scope_exists'); created = true
    await redis.sadd('unoapi-sessions:index', phone); await redis.set(`unoapi-status:${phone}`, 'offline')
    const native = createRedisStore({ redis, keyPrefix: 'unoapi:zapo:' }), expiry = Date.now() + 3600000, timestamp = Date.now() - 60000
    for (let i = 0; i < 320; i++) {
      const id = `E2E_PROVIDER_${String(i).padStart(5, '0')}`, uno = `E2E_UNO_${String(i).padStart(5, '0')}`, jid = i < 265 ? direct : group
      const content = { conversation: 'Synthetic storage validation' }, key = { id, remoteJid: jid, fromMe: false, ...(jid === group ? { participant: direct } : {}) }
      await native.stores.messages(phone).upsert({ id, threadJid: jid, fromMe: false, timestampMs: timestamp + i, ...(jid === group ? { participantJid: direct, senderJid: direct } : {}), messageBytes: proto.Message.encode(content).finish() })
      await redis.pipeline().set(`unoapi-id:${phone}:${id}`, uno, 'PXAT', expiry).set(`unoapi-id_rev:${phone}:${uno}`, id, 'PXAT', expiry)
        .set(`unoapi-key:${phone}:${id}`, JSON.stringify(key), 'PXAT', expiry)
        .set(`unoapi-message:${phone}:${jid}:${id}`, Buffer.from(proto.WebMessageInfo.encode({ key, message: content, messageTimestamp: Math.floor((timestamp + i) / 1000) }).finish()).toString('base64'), 'PXAT', expiry).exec()
    }
    await redis.zadd(`unoapi-status-recipients:${phone}`, timestamp, direct)
    await redis.set(`unoapi-status-media:${phone}:SYNTHETIC`, JSON.stringify({ synthetic: true }), 'PXAT', expiry)
    await redis.set(`unoapi-history-sync:${phone}:started`, 'synthetic-coordination')
    await redis.lpush(`unoapi-webhook-history:${phone}`, JSON.stringify({ synthetic: true }))
    const fencedKey = `unoapi-profile-picture:${phone}:synthetic`
    const oldSelection = JSON.stringify({ exists: true, descriptor: initial.sessionStorage })
    assert.equal(await redis.eval(PRIVATE_REDIS_FENCE_LUA + "return redis.call('SET',KEYS[1],'synthetic')", 2, fencedKey, configKey, oldSelection), 'OK')
    console.log(JSON.stringify({ event: 'synthetic_fixture_prepared', messages: 320, realSends: 0 }))
    const migrated = await task(`${storagePath}/migrations`, { target: 'sqlite', confirm: true })
    assert.equal(migrated.sourcePreserved, false); assert.equal(migrated.sourceCleanup.skipped, 0)
    assert.equal(migrated.reconnect.status, 'skipped'); await rememberBackup(migrated.backupId)
    let config = await fresh(); ownedStorageIds.add(config.sessionStorage.storageId)
    let db = openSessionDatabase(phone, config)
    await assert.rejects(redis.eval(PRIVATE_REDIS_FENCE_LUA + "return redis.call('SET',KEYS[1],'late-write')", 2, fencedKey, configKey, oldSelection), /session_storage_generation_changed/)
    assert.equal(await redis.exists(fencedKey), 0, 'late_cache_write_recreated_source')
    assert.equal(await redis.exists(`unoapi-history-sync:${phone}:started`), 1, 'coordination_deleted')
    assert.equal(await redis.exists(`unoapi-webhook-history:${phone}`), 1, 'configuration_history_deleted')
    const originalKeys = db.all('SELECT key FROM uno_source_fingerprints').map(row => row.key)
    for (let offset = 0; offset < originalKeys.length; offset += 100) assert.equal(await redis.exists(...originalKeys.slice(offset, offset + 100)), 0, 'source_keys_retained')
    assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok'); assert.ok(db.getValue(`unoapi-status-media:${phone}:SYNTHETIC`))
    assert.equal(db.get('SELECT count(*) n FROM mailbox_messages').n, 320)
    await verifyPages()
    const manual = await task(`${storagePath}/backups`, { confirm: true }); await rememberBackup(manual.id)
    const { mediaStore } = await config.getStore(phone, config)
    const objects = { save: async () => { throw Error('unexpected_upload') }, open: key => mediaStore.downloadMediaStream(key) }
    const index = { put: async () => {}, get: async id => JSON.parse(await redis.get(`unoapi-session-storage:backup:${id}`)) }
    const service = new SessionSqliteBackups(objects, index)
    const validation = resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage', config.sessionStorage.storageId, `e2e-readback-${marker}.sqlite`)
    try {
      assert.equal(manual.protection, 'none')
      const restored = await service.restore({ phone, backupId: manual.id, stagedPath: validation })
      assert.equal(restored.supplement.configuration.sessionStorage.fixture, true)
      assert.equal(restored.supplement.configuration.storageE2E, marker)
    } finally { await rm(validation, { force: true }) }
    const restored = await task(`${storagePath}/restores`, { backupId: manual.id, mode: 'offline', confirm: true })
    assert.equal(restored.autoConnect, false)
    config = await fresh(); ownedStorageIds.add(config.sessionStorage.storageId); assert.equal(config.autoConnect, false)
    assert.equal(config.sessionStorage.fixture, true); await verifyPages()
    const status = await http(storagePath); assert.equal(status.backupPolicy.intervalHours, 12); assert.equal(status.backupPolicy.enabled, true)
    assert.equal(status.backupPolicy.location.bucket, 'viperconnect-lab'); assert.equal(status.backupPolicy.retention.slots, 7)
    assert.equal(status.restoreUpload.available, true)
    const archive = await backupObjects.open(manual.objectKey), chunks = []; let uploadedBytes = 0
    try { for await (const chunk of archive) { uploadedBytes += chunk.length; assert.ok(uploadedBytes < 10 * 1024 * 1024); chunks.push(Buffer.from(chunk)) } } finally { archive.destroy() }
    const uploadResponse = await fetch(`http://web:9876${storagePath}/restore-upload?confirm=true&mode=offline`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, 'Content-Type': 'application/octet-stream', 'Content-Length': String(uploadedBytes) },
      body: Buffer.concat(chunks), signal: AbortSignal.timeout(30000),
    }); requests++; assert.equal(uploadResponse.status, 202, 'upload_not_accepted')
    const uploadRestored = await poll(await uploadResponse.json()); assert.equal(uploadRestored.autoConnect, false)
    config = await fresh(); ownedStorageIds.add(config.sessionStorage.storageId); await verifyPages()
    const day = backupWeekday(manual.createdAt, 'America/Cuiaba'), slot = await backupObjects.json(`backups/session-storage/${phone}/slots/${day}.json`)
    assert.equal(slot.value.manifest.id, manual.id)
    success = true
    console.log(JSON.stringify({ event: 'synthetic_e2e_passed', httpRequests: requests, messages: 320, sourceKeysRemoved: originalKeys.length,
      s3UploadReadback: true, keylessConfigurationVerified: true, protection: manual.protection, weeklySlotReadback: true, uploadedOfflineRestore: true, offlineRestore: true, realSends: 0, productionWrites: 0 }))
  } finally {
    // Exact, self-created fixture only. Never delete a normal session or reuse a phone.
    if (created && success) {
      const raw = JSON.parse(await redis.get(configKey) || '{}')
      assert.equal(raw.storageE2E, marker); assert.equal(raw.autoConnect, false); assert.equal(raw.sessionStorage.fixture, true)
      assert.equal(await redis.exists(`unoapi-lease:zapo-session:${phone}`), 0, 'fixture_has_socket_owner')
      const config = await fresh(), { mediaStore } = await config.getStore(phone, config)
      for await (const key of backupObjects.keys(`backups/session-storage/${phone}/`)) objectKeys.add(key)
      for (const key of objectKeys) { assert.ok(key.startsWith(`backups/session-storage/${phone}/`)); await backupObjects.remove(key) }
      closeAllSessionDatabases()
      const root = await realpath(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage'))
      for (const id of ownedStorageIds) {
        assert.match(id, /^[a-f0-9-]{36}$/i); const directory = await realpath(resolve(root, id))
        assert.equal(directory, resolve(root, id)); assert.ok(directory.startsWith(root + sep)); await rm(directory, { recursive: true, force: true })
      }
      const keys = []
      for (const pattern of [`unoapi-*:${phone}*`, `unoapi:zapo:*${phone}*`]) {
        let cursor = '0'; do { const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500); cursor = page[0]; for (const key of page[1]) {
          if (new RegExp(`^unoapi-[^:]+:${phone}(?::|$)`).test(key) || key.startsWith(`unoapi-session-storage:task:${phone}:`)
            || key.startsWith(`unoapi-session-storage:journal:${phone}:`) || key.endsWith(':' + phone) || key.includes(':' + phone + ':')) keys.push(key)
        } } while (cursor !== '0')
      }
      for (const id of manifestIds) keys.push(`unoapi-session-storage:backup:${id}`)
      for (const id of businessAccountIds) {
        const key = `unoapi-meta:business_account_id:${id}`
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, key, phone)
      }
      for (let offset = 0; offset < keys.length; offset += 100) await redis.unlink(...keys.slice(offset, offset + 100))
      await redis.srem('unoapi-sessions:index', phone); await redis.publish('unoapi-config:update', phone)
      cleanupComplete = true
    }
    await redis.quit()
    console.log(JSON.stringify({ event: 'synthetic_fixture_cleanup', complete: cleanupComplete, preservedForInspection: created && !cleanupComplete }))
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(JSON.stringify({ event: 'synthetic_e2e_failed', error: error.message })); process.exit(1) })
