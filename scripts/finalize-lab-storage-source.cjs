/* One-shot repair of the previously validated lab migration; never production. */
const { createRequire } = require('node:module')
const { randomUUID, createHash } = require('node:crypto')
const { mkdtemp, rm, open } = require('node:fs/promises')
const { resolve, join, sep } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  if (process.env.STORAGE_FINALIZE_CONFIRM !== 'validated-lab-source' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.REDIS_URL !== 'redis://redis:6379' || process.env.STORAGE_BUCKET_NAME !== 'viperconnect-lab') throw Error('isolated_lab_required')
  const Redis = app('ioredis'), redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
  const { getConfigRedis } = app('/app/dist/src/services/config_redis.js'), { configs } = app('/app/dist/src/services/config.js')
  const { ReloadAmqp } = app('/app/dist/src/services/reload_amqp.js')
  const database = app('/app/dist/src/services/session_storage/database.js')
  const { migrateCompatibilityRedisToSqlite } = app('/app/dist/src/services/session_storage/native_migration.js')
  const phone = '5566936183915', configKey = 'unoapi-config:' + phone, leaseKey = 'unoapi-lease:zapo-session:' + phone
  const expectedStorageId = '365a728e-1e3f-42d9-8c56-a0d1751644d9', originalRaw = await redis.get(configKey), original = JSON.parse(originalRaw || '{}')
  assert.equal(original.sessionStorage?.storageId, expectedStorageId); assert.equal(original.sessionStorage.generation, 2)
  assert.equal(original.sessionStorage.owner, 'mobile_lab'); assert.equal(original.sessionStorage.backend, 'sqlite'); assert.equal(original.autoConnect, true)
  assert.ok(!original.sessionStorage.fixture); assert.equal(await redis.get('unoapi-status:' + phone), 'online')
  const priorId = await redis.get(`unoapi-session-storage:current-task:${phone}`)
  const priorTask = priorId ? JSON.parse(await redis.get(`unoapi-session-storage:task:${phone}:${priorId}`) || '{}') : {}
  const priorCleanup = priorTask.operation === 'source-cleanup' && priorTask.status === 'ready' ? priorTask.result : undefined
  let paused = false, temporary, token, timer
  const load = async value => { configs.delete(value); return getConfigRedis(value) }
  const dispatch = () => new ReloadAmqp(load).run(phone)
  const stable = config => config.sessionStorage?.storageId === expectedStorageId && config.sessionStorage.generation === 2 && config.sessionStorage.owner === 'mobile_lab' && config.provider === original.provider
  async function http(path, body, expected = 200) {
    const response = await fetch('http://web:9876' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, expected, 'unexpected_http_status'); return response.json()
  }
  async function task(suffix, body) {
    const accepted = await http(`/v15.0/${phone}/storage/${suffix}`, body, 202), end = Date.now() + 180000
    while (Date.now() < end) {
      const t = await http(`/v15.0/${phone}/storage/tasks/${accepted.id}`)
      if (t.status === 'ready') return t.result
      if (t.status !== 'running') throw Error('finalize_task_failed:' + (t.error || t.status))
      await new Promise(done => setTimeout(done, 300))
    }
    throw Error('finalize_task_timeout')
  }
  async function release() {
    if (timer) clearInterval(timer); timer = undefined
    if (token) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, leaseKey, token)
    token = undefined
  }
  try {
    const next = JSON.stringify({ ...original, autoConnect: false })
    assert.equal(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2]); redis.call('PUBLISH','unoapi-config:update',ARGV[3]); return 1", 1, configKey, originalRaw, next, phone), 1)
    paused = true; await dispatch()
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && (await redis.exists(leaseKey) || await redis.get('unoapi-status:' + phone) !== 'offline')) await new Promise(done => setTimeout(done, 250))
    assert.equal(await redis.exists(leaseKey), 0, 'socket_not_released'); assert.equal(await redis.get('unoapi-status:' + phone), 'offline')
    await task('backups', { confirm: true })
    token = randomUUID(); assert.equal(await redis.set(leaseKey, token, 'NX', 'PX', 120000), 'OK')
    let lost = false
    timer = setInterval(() => { void redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) end return 0", 1, leaseKey, token).then(n => { if (n !== 1) lost = true }, () => { lost = true }) }, 15000); timer.unref()
    temporary = await mkdtemp(join(tmpdir(), 'viper-lab-source-repair-'))
    const staged = join(temporary, 'compatibility.sqlite'), reservation = await open(staged, 'wx', 0o600); await reservation.close()
    await migrateCompatibilityRedisToSqlite(redis, phone, staged)
    const source = database.openPreparedSessionDatabase(staged), config = { ...await load(phone), baseStore: process.env.SESSION_STORAGE_ROOT }, target = database.openSessionDatabase(phone, config)
    let adopted = 0
    try {
      assert.equal(target.get('PRAGMA quick_check').quick_check, 'ok')
      const privateKeys = [`unoapi-own-profile-cover:v1:${phone}`, `unoapi-status-recipients:${phone}`]
      // Retired conflicting cache values are retained on disk and in the encrypted
      // backup; the current SQLite value always wins. Never replay old auth/state.
      target.exec('CREATE TABLE IF NOT EXISTS uno_retired_redis_source(key TEXT PRIMARY KEY,dump BLOB NOT NULL,expires_at INTEGER)')
      for (const key of privateKeys) {
        if (target.get('SELECT 1 x FROM uno_source_fingerprints WHERE key=?', [key])) continue
        const fingerprint = source.get('SELECT * FROM uno_source_fingerprints WHERE key=?', [key]); if (!fingerprint) continue
        const dump = await redis.dumpBuffer(key); if (!dump) continue
        assert.equal(createHash('sha1').update(dump).digest('hex'), fingerprint.sha1, 'private_source_changed')
        const tables = ['uno_kv', 'uno_hash', 'uno_set', 'uno_zset', 'uno_list']
        target.transaction(() => {
          const exists = tables.some(table => target.get('SELECT 1 x FROM ' + table + ' WHERE key=? LIMIT 1', [key]))
          if (!exists) for (const table of tables) for (const row of source.all('SELECT * FROM ' + table + ' WHERE key=?', [key])) {
            const columns = Object.keys(row); target.run('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')', Object.values(row))
          }
          target.run('INSERT INTO uno_retired_redis_source VALUES(?,?,?)', [key, dump, fingerprint.expires_at])
          target.run('INSERT INTO uno_source_fingerprints(key,sha1,expires_at,captured_at) VALUES(?,?,?,?)', [key, fingerprint.sha1, fingerprint.expires_at, fingerprint.captured_at])
          adopted++
        })
      }
      assert.equal(lost, false, 'lease_lost'); assert.equal(target.get('PRAGMA quick_check').quick_check, 'ok')
    } finally { source.close() }
    const backup = await task('backups', { confirm: true })
    assert.equal(lost, false, 'lease_lost'); await release()
    const cleaned = await task('source-cleanup', { confirm: true, backupId: backup.id, generation: 2 })
    const result = { ...cleaned, deleted: cleaned.deleted + (priorCleanup?.deleted || 0), deletedKeyBytes: cleaned.deletedKeyBytes + (priorCleanup?.deletedKeyBytes || 0) }
    assert.equal(result.skipped, 0, 'source_diverged')
    const before = JSON.parse(await redis.get(`unoapi-session-storage:migration-metrics:${phone}`) || '{}')
    await redis.set(`unoapi-session-storage:migration-metrics:${phone}`, JSON.stringify({ ...before, sourcePreserved: false, sourceCleanup: result, backupId: backup.id }))
    console.log(JSON.stringify({ event: 'previous_lab_migration_finalized', adoptedPrivateRecords: adopted, deleted: result.deleted,
      missing: result.missing, skipped: result.skipped, retainedControl: result.retainedControl, deletedKeyBytes: result.deletedKeyBytes, backupVerified: true, realSends: 0, productionWrites: 0 }))
  } finally {
    await release()
    database.closeAllSessionDatabases()
    if (temporary) { const parent = resolve(tmpdir()); assert.ok(resolve(temporary).startsWith(parent + sep)); assert.ok(temporary.split(sep).at(-1).startsWith('viper-lab-source-repair-')); await rm(temporary, { recursive: true, force: true }) }
    if (paused) {
      const currentRaw = await redis.get(configKey), current = JSON.parse(currentRaw || '{}')
      assert.ok(stable(current), 'configuration_changed_before_resume')
      if (current.autoConnect === false) {
        const resume = JSON.stringify({ ...current, autoConnect: true })
        assert.equal(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2]); redis.call('PUBLISH','unoapi-config:update',ARGV[3]); return 1", 1, configKey, currentRaw, resume, phone), 1)
        await dispatch()
      }
      console.log(JSON.stringify({ event: 'lab_session_resume_requested', requested: true }))
    }
    await redis.quit()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(JSON.stringify({ event: 'lab_finalize_failed', error: error.message })); process.exit(1) })
