// Controlled fixture for actual browser restore. Run inside the LAB worker only.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { randomUUID, randomInt } = require('node:crypto')
const { readFile, writeFile, realpath, rm } = require('node:fs/promises')
const { resolve, sep } = require('node:path')
const a = createRequire('/app/package.json')
const statePath = '/tmp/viper-front-restore-20261110.json'

async function main() {
  assert.equal(process.env.STORAGE_FRONT_QA_CONFIRM, 'synthetic-lab-only')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
  assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
  const redis = new (a('ioredis'))(process.env.REDIS_URL)
  const { openSessionDatabase, closeAllSessionDatabases } = a('/app/dist/src/services/session_storage/database.js')
  const { createBackupObjects } = a('/app/dist/src/services/session_storage/backup_objects.js')
  const objects = createBackupObjects()
  const phase = process.env.STORAGE_FRONT_QA_PHASE
  let state = JSON.parse(await readFile(statePath, 'utf8').catch(() => 'null'))
  const save = () => writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  const request = async (path, init = {}, expected = 200) => {
    const response = await fetch('http://web:9876' + path, { ...init,
      headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, ...init.headers }, signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, expected, 'fixture_http_' + response.status)
    return response.json()
  }
  try {
    if (phase === 'prepare') {
      assert.equal(state, null, 'previous_fixture_requires_cleanup')
      state = { phone: '999015' + randomInt(1000000, 9999999), marker: randomUUID(), storageIds: [randomUUID()], ids: [], rows: 128 }
      await save()
      const config = { provider: 'zapo', server: 'mobile_lab', useRedis: true, useS3: true, autoConnect: false,
        name: 'QA front restore ' + state.marker, webhooks: [], overrideWebhooks: true, sessionWebhook: '', storageFrontQa: state.marker,
        sessionStorage: { backend: 'sqlite', owner: 'mobile_lab', storageId: state.storageIds[0], generation: 1, state: 'offline', fixture: true } }
      assert.equal(await redis.exists('unoapi-config:' + state.phone), 0)
      assert.equal(await redis.set('unoapi-config:' + state.phone, JSON.stringify(config), 'NX'), 'OK')
      await redis.sadd('unoapi-sessions:index', state.phone); await redis.set('unoapi-status:' + state.phone, 'offline')
      const db = openSessionDatabase(state.phone, { ...config, baseStore: process.env.SESSION_STORAGE_ROOT }, { create: true })
      const { sqliteSdkConnection } = a('/app/dist/src/services/session_storage/native_migration.js')
      const { createSqliteStore, ensureSqliteMigrations } = a('@zapo-js/store-sqlite')
      const { proto } = a('zapo-js'), connection = sqliteSdkConnection(db)
      await ensureSqliteMigrations(connection, ['mailbox'])
      const store = createSqliteStore({ connection }), expiry = Date.now() + 86400000
      for (let i = 0; i < state.rows; i++) {
        const provider = 'FRONT_PROVIDER_' + i, uno = 'FRONT_UNO_' + i
        await store.stores.messages(state.phone).upsert({ id: provider, threadJid: '111111111@lid', fromMe: false,
          timestampMs: Date.now() - 60000 + i, messageBytes: proto.Message.encode({ conversation: 'QA browser restore ' + state.marker + ' ' + i }).finish() })
        db.putValue(`unoapi-id:${state.phone}:${provider}`, uno, { encoding: 'string', expiresAt: expiry })
        db.putValue(`unoapi-id_rev:${state.phone}:${uno}`, provider, { encoding: 'string', expiresAt: expiry })
      }
      db.putValue(`unoapi-contact-name:${state.phone}:111111111@lid`, 'Original before backup', { expiresAt: expiry })
      closeAllSessionDatabases()
      await redis.publish('unoapi-config:update', state.phone)
      console.log(JSON.stringify({ prepared: true, phone: state.phone, synthetic: true, rows: state.rows }))
      return
    }
    assert.ok(state); assert.match(state.phone, /^999015\d{7}$/)
    const raw = await redis.get('unoapi-config:' + state.phone), config = raw && JSON.parse(raw)
    assert.ok(!config || config.storageFrontQa === state.marker && config.sessionStorage?.fixture === true && config.autoConnect === false)
    assert.equal(await redis.exists(`unoapi-lease:zapo-session:${state.phone}`, `unoapi-session-storage:task:lock:${state.phone}`, `unoapi-session-storage:standalone-job:${state.phone}`), 0)
    if (config && !state.storageIds.includes(config.sessionStorage.storageId)) { state.storageIds.push(config.sessionStorage.storageId); await save() }
    if (phase === 'withdraw') {
      assert.ok(config)
      const library = await request(`/manager/storage/${state.phone}/backups`)
      assert.ok(library.latest?.id); state.ids.push(library.latest.id); await save()
      assert.equal(Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('DEL',KEYS[1],KEYS[2]);redis.call('SREM',KEYS[3],ARGV[2]);redis.call('PUBLISH','unoapi-config:update',ARGV[2]);return 1", 3,
        'unoapi-config:' + state.phone, 'unoapi-status:' + state.phone, 'unoapi-sessions:index', raw, state.phone)), 1)
      console.log(JSON.stringify({ destinationAbsent: true, phone: state.phone, backupId: library.latest.id }))
    } else if (phase === 'verify') {
      assert.ok(config)
      assert.equal(await redis.get('unoapi-status:' + state.phone), 'offline')
      const db = openSessionDatabase(state.phone, { ...config, baseStore: process.env.SESSION_STORAGE_ROOT })
      assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok')
      assert.equal(Number(db.get('SELECT COUNT(*) n FROM mailbox_messages WHERE session_id=?', [state.phone]).n), state.rows)
      const { validateLiveIdMappings } = a('/app/dist/src/services/session_storage/id_validation.js')
      assert.equal(validateLiveIdMappings(db, state.phone), true)
      assert.equal(db.getValue(`unoapi-contact-name:${state.phone}:111111111@lid`).toString(), 'Original before backup')
      assert.equal(db.getValue(`unoapi-id:${state.phone}:FRONT_PROVIDER_0`).toString(), 'FRONT_UNO_0')
      const page = await request(`/v15.0/${state.phone}/conversations/111111111%40lid/messages?limit=100`)
      assert.equal(page.data.length, 100); assert.equal(page.has_more, true)
      state.verified = true; await save()
      console.log(JSON.stringify({ verified: true, phone: state.phone, rows: state.rows, integrity: true, idPairs: true, offline: true, autoConnect: false, fixture: true }))
    } else if (phase === 'mutate') {
      assert.ok(config)
      const db = openSessionDatabase(state.phone, { ...config, baseStore: process.env.SESSION_STORAGE_ROOT })
      db.putValue(`unoapi-contact-name:${state.phone}:111111111@lid`, 'Changed after backup')
      console.log(JSON.stringify({ syntheticMarkerChanged: true, phone: state.phone }))
    } else if (phase === 'cleanup') {
      assert.equal(state.verified, true)
      closeAllSessionDatabases()
      // Never unlink a database while another process still has it open.
      const fs = a('node:fs')
      for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
        let handles
        try { handles = fs.readdirSync('/proc/' + pid + '/fd') } catch { continue }
        for (const handle of handles) {
          let path
          try { path = fs.readlinkSync('/proc/' + pid + '/fd/' + handle) } catch { continue }
          assert.ok(!state.storageIds.some(id => path.includes('/session-storage/' + id + '/')), 'fixture_database_still_open')
        }
      }
      for await (const key of objects.keys(`backups/session-storage/${state.phone}/`)) {
        const id = key.match(/\/([a-f0-9-]{36})\.viperstorage/)?.[1]; if (id) state.ids.push(id)
        await objects.remove(key)
      }
      const root = await realpath(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage'))
      for (const id of state.storageIds) {
        assert.match(id, /^[a-f0-9-]{36}$/)
        const directory = resolve(root, id); assert.ok(directory.startsWith(root + sep)); assert.equal(await realpath(directory), directory)
        await rm(directory, { recursive: true, force: true })
      }
      const keys = new Set(['unoapi-config:' + state.phone, 'unoapi-status:' + state.phone])
      let cursor = '0'
      do { const page = await redis.scan(cursor, 'MATCH', '*' + state.phone + '*', 'COUNT', 500); cursor = page[0]
        for (const key of page[1]) if (key.startsWith('unoapi-') && (key.endsWith(':' + state.phone) || key.includes(':' + state.phone + ':'))) keys.add(key)
      } while (cursor !== '0')
      for (const id of new Set(state.ids)) keys.add('unoapi-session-storage:backup:' + id)
      if (config?.webhookForward?.businessAccountId) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, 'unoapi-meta:business_account_id:' + config.webhookForward.businessAccountId, state.phone)
      await redis.unlink(...keys); await redis.srem('unoapi-sessions:index', state.phone); await redis.publish('unoapi-config:update', state.phone)
      await rm(statePath)
      console.log(JSON.stringify({ syntheticCleanup: true, directories: state.storageIds.length, redisKeys: keys.size }))
    } else throw new Error('unknown_fixture_phase')
  } finally { closeAllSessionDatabases(); await redis.quit() }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1) })
