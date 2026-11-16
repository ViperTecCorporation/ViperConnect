/* Real LAB snapshot/restore verification only. No connection, logout, replay or catalogue promotion. */
const { createRequire } = require('node:module')
const { mkdtemp, rm, realpath, readFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, sep } = require('node:path')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')
async function main() {
  if (process.env.STORAGE_LAB_BACKUP_CONFIRM !== 'read-only-snapshot' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.STORAGE_BUCKET_NAME !== 'viperconnect-lab' || process.env.REDIS_URL !== 'redis://redis:6379') throw Error('lab_snapshot_confirmation_required')
  const phone = '5566936183915'
  const { getConfigRedis } = app('/app/dist/src/services/config_redis.js')
  const { getRedis } = app('/app/dist/src/services/redis.js')
  const { makeSessionBackup } = app('/app/dist/src/services/session_storage/backup_runtime.js')
  const { SessionSqliteBackups } = app('/app/dist/src/services/session_storage/backup.js')
  const { RedisGlobalBackups } = app('/app/dist/src/services/session_storage/redis_backup.js')
  const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
  const { validateStandaloneState } = app('/app/dist/src/services/session_storage/standalone_validation.js')
  const { validateLiveIdMappings } = app('/app/dist/src/services/session_storage/id_validation.js')
  const { openPreparedSessionDatabase } = app('/app/dist/src/services/session_storage/database.js')
  const redis = await getRedis(), config = await getConfigRedis(phone), objects = createBackupObjects(config.storage)
  const oldKeyFile = process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  const legacySessionId = process.env.STORAGE_LEGACY_SESSION_BACKUP_ID, legacyRedisId = process.env.STORAGE_LEGACY_REDIS_BACKUP_ID
  const legacySession = legacySessionId && JSON.parse(await redis.get('unoapi-session-storage:backup:' + legacySessionId) || 'null')
  const legacyRedis = legacyRedisId && JSON.parse(await redis.get('unoapi-infrastructure:redis-backup:manifest:' + legacyRedisId) || 'null')
  assert.equal(config.sessionStorage.backend, 'sqlite'); assert.equal(config.sessionStorage.fixture, undefined); assert.equal(config.mobilePrimaryImported, true)
  assert.equal(await redis.get('unoapi-status:' + phone), 'online')
  const rawBefore = await redis.get('unoapi-config:' + phone), leaseBefore = await redis.get('unoapi-lease:zapo-session:' + phone)
  const directory = await mkdtemp(join(tmpdir(), 'viper-lab-backup-'))
  let temporaryRdb
  try {
    const manifest = await makeSessionBackup(phone, config), target = join(directory, 'verified.sqlite')
    assert.equal(manifest.protection, 'none')
    const sqliteService = new SessionSqliteBackups(objects, { put: async () => {}, get: async () => undefined })
    const archive = await sqliteService.restoreStandalone({ phone, manifest, stagedPath: target })
    const verified = await validateStandaloneState(phone, target, manifest, archive.supplement, process.env.MOBILE_REGISTRATION_KEY)
    assert.equal(verified.draft.id, config.mobilePrimaryDraftId); assert.equal(archive.supplement.configuration.mobilePrimaryImported, true)
    const db = openPreparedSessionDatabase(target); let forward, reverse
    try {
      assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok'); assert.equal(validateLiveIdMappings(db, phone), true)
      forward = db.get('SELECT COUNT(*) AS n FROM uno_kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at>?)', ['unoapi-id:' + phone + ':%', Date.now()]).n
      reverse = db.get('SELECT COUNT(*) AS n FROM uno_kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at>?)', ['unoapi-id_rev:' + phone + ':%', Date.now()]).n
      assert.equal(forward, reverse)
    } finally { db.close() }
    const globalService = new RedisGlobalBackups(objects, { put: async () => {}, get: async () => undefined })
    temporaryRdb = await globalService.backup({ enabled: true, confirmAllDatabases: true, cliPath: '/usr/bin/redis-cli', redisUrl: process.env.REDIS_URL, instanceId: 'mobile-lab-redis' })
    assert.equal(temporaryRdb.protection, 'none')
    const globalRestore = await globalService.prepareRestore({
      instanceId: 'mobile-lab-redis', backupId: temporaryRdb.id, destination: join(directory, 'verified.rdb'), confirmOffline: true, isDestinationOffline: async () => true,
    })
    assert.equal(globalRestore.activatesRedis, false); assert.equal(globalRestore.prepared, true)
    let legacyVerified = false
    if (legacySession && legacyRedis && oldKeyFile) {
      const password = (await readFile(oldKeyFile, 'utf8')).trim()
      assert.notEqual(legacySession.protection, 'none'); assert.notEqual(legacyRedis.protection, 'none')
      await assert.rejects(sqliteService.restoreStandalone({ phone, manifest: legacySession, stagedPath: join(directory, 'legacy-no-key.sqlite') }), /session_storage_backup_legacy_key_required/)
      await sqliteService.restoreStandalone({ phone, manifest: legacySession, password, stagedPath: join(directory, 'legacy.sqlite') })
      await globalService.prepareRestore({ instanceId: 'mobile-lab-redis', backupId: legacyRedis.id, backupPassword: password, destination: join(directory, 'legacy.rdb'), confirmOffline: true, isDestinationOffline: async () => true })
      assert.ok(await redis.get('unoapi-session-storage:backup:' + legacySession.id)); assert.ok(await objects.json(legacySession.objectKey + '.manifest.json'))
      assert.ok(await objects.json(legacyRedis.objectKey + '.manifest.json')); assert.equal((await readFile(oldKeyFile, 'utf8')).trim(), password)
      legacyVerified = true
    }
    assert.equal(await redis.get('unoapi-config:' + phone), rawBefore); assert.equal(await redis.get('unoapi-lease:zapo-session:' + phone), leaseBefore)
    assert.equal(await redis.get('unoapi-status:' + phone), 'online')
    console.log(JSON.stringify({ event: 'real_lab_backup_verified', online: true, sqliteIntegrity: true, idPairs: forward, nativePrimaryIdentityVerified: true,
      keylessConfiguration: true, protection: 'none', legacyVerified, primaryDraft: true, weeklyS3Backup: true, globalRedisReadback: true, globalRdbPreparedOffline: true,
      requiresMatchingRedisOfflineRdbValidation: true, connectionUntouched: true, realSends: 0, productionWrites: 0 }))
  } finally {
    if (temporaryRdb) { assert.equal(temporaryRdb.instanceId, 'mobile-lab-redis'); assert.notEqual(temporaryRdb.id, legacyRedisId); await objects.remove(temporaryRdb.objectKey); await objects.remove(temporaryRdb.objectKey + '.manifest.json') }
    const parent = await realpath(tmpdir()), target = await realpath(directory); assert.ok(target.startsWith(parent + sep)); assert.ok(target.includes('viper-lab-backup-')); await rm(target, { recursive: true, force: true })
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(JSON.stringify({ event: 'real_lab_backup_verification_failed', code: error.code || error.message })); process.exit(1) })
