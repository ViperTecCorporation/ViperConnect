/* Real DEV register -> owner RPC -> SQLite -> Zapo QR. Never scans the QR. */
const { createRequire } = require('node:module')
const { randomUUID, randomInt } = require('node:crypto')
const { resolve, sep } = require('node:path')
const { realpath, rm, stat } = require('node:fs/promises')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  if (process.env.STORAGE_NEW_QR_CONFIRM !== 'unpaired-lab-only' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.REDIS_URL !== 'redis://redis:6379' || process.env.SESSION_STORAGE_DEFAULT !== 'sqlite'
    || process.env.STORAGE_BUCKET_NAME !== 'viperconnect-lab' || process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY === 'true') throw Error('isolated_lab_opt_in_required')
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  redis.on('error', () => {})
  const phone = '999013' + randomInt(1000000, 9999999), marker = randomUUID(), name = 'New QR storage audit ' + marker
  const configKey = `unoapi-config:${phone}`, leaseKey = `unoapi-lease:zapo-session:${phone}`
  const headers = { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN, 'Content-Type': 'application/json' }
  const { DatabaseSync } = app('node:sqlite')
  let created = false, verified = false, cleanup = false, stage = 'preflight', socket, businessId, preparedStorageId
  const nativePrefix = app('/app/dist/src/services/zapo/zapo_store.js').resolveZapoRedisKeyPrefix(process.env.ZAPO_REDIS_KEY_PREFIX)
  const http = async (path, body) => {
    const r = await fetch('http://web:9876' + path, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    assert.ok(r.ok, 'new_qr_http_' + r.status)
    return r.status === 204 ? undefined : r.json()
  }
  const wait = async (predicate, timeout) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await predicate()) return; await new Promise(done => setTimeout(done, 250)) }
    throw Error('new_qr_timeout')
  }
  const databasePath = id => {
    assert.match(id || '', /^[a-f0-9-]{36}$/)
    return resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage', id, 'session.sqlite')
  }
  try {
    assert.equal(await redis.exists(configKey, leaseKey), 0)
    const destinations = Object.values(await redis.hgetall('unoapi-session-webhooks:destinations')).map(x => JSON.parse(x))
    assert.equal(destinations.filter(d => d.server === 'mobile_lab' && d.auto_include_new_sessions).length, 0, 'test_auto_enrollment_present')
    stage = 'register-paused'
    created = true // cleanup still checks the unique name before touching anything
    const registered = await http(`/v15.0/${phone}/register`, { name, provider: 'zapo', connectionType: 'qrcode', zapoWebClientProfile: 'default',
      server: 'mobile_lab', autoConnect: false, webhooks: [], overrideWebhooks: true })
    let config = JSON.parse(await redis.get(configKey))
    assert.equal(config.name, name); assert.equal(config.server, 'mobile_lab'); assert.equal(config.autoConnect, false)
    assert.equal(config.sessionStorage?.backend, 'sqlite'); assert.equal(config.sessionStorage?.owner, 'mobile_lab')
    assert.equal(config.sessionStorageProvisioned?.backend, 'sqlite'); assert.equal(config.sessionStorageProvisionPending, null)
    businessId = registered.webhookForward?.businessAccountId
    const id = config.sessionStorage.storageId
    preparedStorageId = id
    const db = new DatabaseSync(databasePath(id), { readOnly: true })
    try { assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok') } finally { db.close() }
    assert.equal(await redis.exists(leaseKey), 0, 'paused_session_opened_socket')
    let gotQr = false
    socket = app('socket.io-client').io('http://web:9876', { path: '/ws', transports: ['websocket'], reconnection: false })
    socket.on('broadcast', event => {
      if (event.phone === phone && event.type === 'qrcode' && typeof event.content === 'string' && event.content.startsWith('data:image/')) gotQr = true
      // QR is sensitive: never log, save, forward or print its contents.
    })
    await wait(() => socket.connected, 10000)
    stage = 'zapo-real-qr'
    const activated = await http(`/v15.0/${phone}/register`, { autoConnect: true, webhooks: [], overrideWebhooks: true })
    assert.notEqual(activated.registerSuppressed, true, 'changed_connect_intention_suppressed')
    await wait(() => gotQr, 60000)
    config = JSON.parse(await redis.get(configKey))
    assert.equal(config.sessionStorage.storageId, id); assert.equal(config.sessionStorage.backend, 'sqlite')
    stage = 'qr-native-sql'
    const native = new DatabaseSync(databasePath(id), { readOnly: true })
    try {
      const auth = native.prepare('SELECT me_jid,length(noise_pub_key) noise,length(identity_pub_key) identity_bytes FROM auth_credentials WHERE session_id=?').get(phone)
      assert.ok(auth && !auth.me_jid && auth.noise > 0 && auth.identity_bytes > 0)
      // The official SDK migrates mailbox lazily. An unscanned QR may have auth
      // and Signal tables without ever having opened the message store.
      const mailbox = native.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='mailbox_messages'").get()
      if (mailbox) assert.equal(Number(native.prepare('SELECT COUNT(*) n FROM mailbox_messages WHERE session_id=?').get(phone).n), 0)
    } finally { native.close() }
    let cursor = '0', nativeRedisKeys = 0
    do { const page = await redis.scan(cursor, 'MATCH', `${nativePrefix}*:${phone}*`, 'COUNT', 1000); cursor = page[0]; nativeRedisKeys += page[1].length } while (cursor !== '0')
    assert.equal(nativeRedisKeys, 0, 'new_sqlite_session_wrote_native_redis')
    verified = true
    console.log(JSON.stringify({ newQrRealPassed: true, provisionBeforeConnect: true, durableReceipt: true, sqliteAuthGenerated: true,
      realZapoQr: true, nativeRedisKeys, paired: false, realMessages: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ newQrStage: stage, error: error.code || error.name, verified }))
    throw error
  } finally {
    socket?.disconnect()
    if (created) {
      const raw = await redis.get(configKey), current = raw && JSON.parse(raw)
      if (current?.name === name) {
        await http(`/v15.0/${phone}/register`, { autoConnect: false, webhooks: [], overrideWebhooks: true })
        await wait(async () => !await redis.exists(leaseKey), 30000)
        const before = await redis.get(configKey), config = JSON.parse(before)
        assert.equal(config.name, name); assert.equal(config.autoConnect, false)
        const storageId = config.sessionStorage?.storageId || config.sessionStorageProvisionPending?.id
        if (preparedStorageId) assert.equal(storageId, preparedStorageId, 'test_storage_replaced_preserve_it')
        if (config.sessionStorage) {
          assert.equal(config.sessionStorage.backend, 'sqlite'); assert.equal(config.sessionStorage.owner, 'mobile_lab')
          assert.equal(config.sessionStorage.generation, 1, 'test_storage_transitioned_preserve_it')
        }
        const path = storageId && databasePath(storageId)
        if (path && await stat(path).then(() => true, () => false)) {
          const db = new DatabaseSync(path, { readOnly: true })
          try {
            assert.equal(db.prepare('SELECT value FROM uno_storage_meta WHERE key=?').get('phone')?.value, phone, 'test_database_identity_changed_preserve_it')
            if (db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='auth_credentials'").get()) {
              const auth = db.prepare('SELECT session_id,me_jid FROM auth_credentials').all()
              assert.ok(auth.every(row => row.session_id === phone && !row.me_jid), 'test_was_paired_preserve_it')
            }
            if (db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='mailbox_messages'").get()) {
              assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM mailbox_messages').get().n), 0, 'test_has_message_history_preserve_it')
            }
          } finally { db.close() }
        }
        const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
        const objects = createBackupObjects(), prefix = `backups/session-storage/${phone}/`, manifests = new Set()
        for await (const key of objects.keys(prefix)) {
          assert.ok(key.startsWith(prefix))
          const match = key.match(new RegExp('^' + prefix + '([a-f0-9-]{36})\\.viperstorage(?:\\.manifest\\.json)?$'))
          if (match) manifests.add(match[1])
          await objects.remove(key)
        }
        for (const id of manifests) {
          const key = `unoapi-session-storage:backup:${id}`, value = await redis.get(key)
          if (value && JSON.parse(value).phone === phone) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, key, value)
        }
        assert.equal(Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('EXISTS',KEYS[2])~=0 then return 0 end; redis.call('DEL',KEYS[1]);redis.call('SREM',KEYS[3],ARGV[2]);redis.call('HDEL',KEYS[4],ARGV[2]);redis.call('HDEL',KEYS[5],ARGV[2]);redis.call('PUBLISH','unoapi-config:update',ARGV[2]);return 1", 5,
          configKey, leaseKey, 'unoapi-sessions:index', 'unoapi-session-webhooks:states', 'unoapi-session-webhooks:heartbeat', before, phone)), 1)
        const ownKeys = []
        for (const pattern of [`unoapi-*:${phone}`, `unoapi-*:${phone}:*`]) {
          let cursor = '0'; do { const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000); cursor = page[0]; ownKeys.push(...page[1]) } while (cursor !== '0')
        }
        if (ownKeys.length) await redis.unlink(...new Set(ownKeys))
        if (businessId) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1, `unoapi-meta:business_account_id:${businessId}`, phone)
        if (storageId) {
          const root = await realpath(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage')), directory = resolve(root, storageId)
          assert.ok(directory.startsWith(root + sep)); assert.equal(await realpath(directory), directory)
          await rm(directory, { recursive: true, force: true })
        }
        cleanup = true
      } else if (!raw) cleanup = true
    }
    await redis.quit()
    console.log(JSON.stringify({ newQrCleanup: cleanup, verified }))
  }
}
main().then(() => process.exit(0)).catch(() => process.exit(1))
