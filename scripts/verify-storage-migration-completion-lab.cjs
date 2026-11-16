/* Synthetic only: real DEV Redis/SQLite and archive codec, simulated object
 * storage and WhatsApp transport. Never registers a session or sends a message. */
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { Readable } = require('node:stream');
const { createClient } = require('/app/node_modules/@redis/client');
const IORedis = require('/app/node_modules/ioredis');
const modules = '/app/dist/src/services/session_storage/';
const { SessionDatabase, closeAllSessionDatabases } = require(modules + 'database.js');
const { SessionStorageTasks } = require(modules + 'tasks.js');
const { SessionStorageCatalog } = require(modules + 'catalog.js');
const { SessionStorageMigration, migrationPaths } = require(modules + 'migration.js');
const { migrateCompatibilityRedisToSqlite, migrateNativeRedisToSqlite } = require(modules + 'native_migration.js');
const { SessionSqliteBackups } = require(modules + 'backup.js');
const { cleanRedisSource, sourceFingerprintsDigest, CLEAN_DEFERRED_SOURCE_BATCH_LUA } = require(modules + 'source_cleanup.js');
const { completeMigration, prepareMigrationCompletion, migrationCompletionKey, migrationCompletionLock } = require(modules + 'migration_completion.js');
const { publishOwnedSqliteConnectionState } = require(modules + 'connection_state.js');
if (process.env.UNOAPI_MOBILE_PRIMARY_LAB !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') throw new Error('local_mobile_lab_required');
const redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false }, disableOfflineQueue: true });
const source = new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on('error', () => {}); source.on('error', () => {});
const ownedKeys = new Set(); const databases = new Set(); let root, assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions++; };
const set = async (key, value, options) => { ownedKeys.add(key); return redis.set(key, value, options); };
const pause = () => new Promise(resolve => setImmediate(resolve));

async function scenario({ eligible, mobile, diverge, interrupt }) {
  const phone = '999' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 90 + 10));
  const owner = 'synthetic-' + randomUUID(), configKey = `unoapi-config:${phone}`, statusKey = `unoapi-status:${phone}`;
  const taskLock = `unoapi-session-storage:task:lock:${phone}`, socketLease = `unoapi-lease:zapo-session:${phone}`;
  const socketToken = randomUUID(), data = `unoapi-message:${phone}:contact:`;
  const idKey = `unoapi-id:${phone}:ZAPO_ORIGINAL`, revKey = `unoapi-id_rev:${phone}:UNO_ORIGINAL`;
  const legacyKey = `unoapi-auth-seen:${phone}`, foreignKey = `unoapi-message:${phone}0:contact:foreign`;
  const config = { provider: 'zapo', server: owner, autoConnect: eligible, ...(mobile ? { mobilePrimaryDraftId: 'synthetic-primary' } : {}) };
  check(await set(configKey, JSON.stringify(config), { NX: true }) === 'OK', 'unique synthetic session');
  await set(statusKey, eligible ? 'online' : 'offline');
  await set(idKey, 'UNO_ORIGINAL'); await set(revKey, 'ZAPO_ORIGINAL');
  await source.zadd(legacyKey, Date.now(), 'not-a-real-auth-key'); ownedKeys.add(legacyKey);
  await set(foreignKey, 'foreign session reference');
  for (let i = 0; i < 205; i++) await set(data + i, JSON.stringify({ key: { id: 'ZAPO_' + i }, message: { conversation: 'synthetic-' + i } }));
  await source.pexpire(data + '204', 600000);
  let localClient = eligible, quiescing = false, db, backup, requests = 0, cleanupCalls = 0, finished = false, interrupted = false;
  const objects = new Map(), manifests = new Map();
  const backups = new SessionSqliteBackups({
    save: async (key, stream) => { const parts = []; for await (const chunk of stream) parts.push(Buffer.from(chunk)); objects.set(key, Buffer.concat(parts)); },
    open: async key => { if (!objects.has(key)) throw new Error('synthetic_object_missing'); return Readable.from([objects.get(key)]); },
  }, {
    put: async m => { manifests.set(m.id, m); await set(`unoapi-session-storage:backup:${m.id}`, JSON.stringify(m)); },
    get: async id => manifests.get(id),
  });
  const verifyBackup = async (manifest, expected) => {
    const path = join(root, `readback-${randomUUID()}.sqlite`);
    await backups.restore({ phone, backupId: manifest.id, stagedPath: path });
    const restored = new SessionDatabase(path);
    try { return sourceFingerprintsDigest(restored) === expected; } finally { restored.close(); }
  };
  const cleanup = async (plan, lease) => {
    cleanupCalls++;
    if (diverge && cleanupCalls === 1) { await source.set(data + '1', 'new-data-do-not-delete'); await source.pexpire(data + '204', 1200000); }
    return cleanRedisSource({ redis: source, database: db, phone, storage: plan.storage, prefix: 'unoapi:zapo:',
      body: { confirm: true, backupId: plan.backupId, generation: plan.storage.generation }, lease,
      deferred: { taskId: plan.taskId, digest: plan.digest }, verifyBackup,
      progress: async () => {
        if (interrupt && !interrupted) { interrupted = true; await set(taskLock, 'synthetic-concurrent-lifecycle'); }
      },
    });
  };
  const completionDeps = { redis, owner, effectsAllowed: () => true, hasClient: () => localClient,
    dispatch: async () => {
      requests++; check(!quiescing, 'quiesce ended before reconnect'); check(!await redis.get(taskLock), 'migration lock released before reload');
      check(!await redis.get(socketLease), 'old socket lease released before reload');
      check((await redis.get(configKey)).includes('"autoConnect":true'), 'intent restored');
      await set(socketLease, socketToken); localClient = true;
      const current = JSON.parse(await redis.get(configKey));
      check(await publishOwnedSqliteConnectionState(redis, phone, current.sessionStorage, { key: socketLease, token: socketToken }, 'online'), 'real event-state Lua accepts owner');
      db.putValue(data + 'after-cutover', 'new SQLite data');
    }, cleanup };
  const catalog = new SessionStorageCatalog(redis);
  const migration = new SessionStorageMigration(catalog, {
    owner, getConfig: async () => ({ ...JSON.parse(await redis.get(configKey)), baseStore: root }),
    quiesce: async () => { quiescing = true; localClient = false; },
    acquireLease: async () => {
      const token = randomUUID(); check(await set(socketLease, token, { NX: true, PX: 120000 }) === 'OK', 'migration lease acquired');
      return { assertOwned: async () => assert.equal(await redis.get(socketLease), token), release: async () => { assert.equal(await redis.get(socketLease), token); await redis.del(socketLease); } };
    },
    importData: async (_phone, path, progress) => {
      const empty = new SessionDatabase(path); empty.close();
      const compatibility = await migrateCompatibilityRedisToSqlite(source, phone, path, progress);
      const native = await migrateNativeRedisToSqlite(source, phone, 'unoapi:zapo:', path, progress);
      const staged = new SessionDatabase(path); staged.run('INSERT OR REPLACE INTO uno_storage_meta VALUES (?,?)', ['phone', phone]); staged.exec('PRAGMA wal_checkpoint(TRUNCATE)'); staged.close();
      return { verified: true, compatibilityRecords: compatibility.records, nativeRecords: native.records };
    },
    validate: async (_phone, path) => {
      const copy = new SessionDatabase(path);
      try { return copy.get('PRAGMA quick_check').quick_check === 'ok' && copy.getValue(idKey).toString() === 'UNO_ORIGINAL' && copy.getValue(revKey).toString() === 'ZAPO_ORIGINAL'; } finally { copy.close(); }
    },
    finalizeSource: async (_phone, storage) => {
      const taskId = await redis.get(taskLock), path = migrationPaths(root, storage.storageId, taskId).final;
      db = new SessionDatabase(path); databases.add(db);
      backup = await backups.backup({ phone, path, storage, ...(mobile ? { kind: 'mobile-primary', supplement: { registration: { synthetic: true } } } : {}) });
      const digest = sourceFingerprintsDigest(db); check(await verifyBackup(backup, digest), 'uploaded archive readback fingerprint verified');
      await prepareMigrationCompletion(redis, { phone, taskId, storage, backupId: backup.id, digest }, { eligible, fixture: false });
      ownedKeys.add(migrationCompletionKey(phone)); ownedKeys.add(migrationCompletionLock(phone));
      check(await redis.exists(idKey) === 1, 'source intact until verified backup');
      return { backupId: backup.id, status: 'pending' };
    },
  });
  const tasks = new SessionStorageTasks(redis, owner), workerLock = `unoapi-session-storage:migration-lock:${owner}`;
  ownedKeys.add(workerLock);
  const task = await tasks.start(phone, 'migration', async id => {
    ownedKeys.add(`unoapi-session-storage:task:${phone}:${id}`); ownedKeys.add(`unoapi-session-storage:journal:${phone}:${id}`);
    try { return await migration.migrate(phone, { target: 'sqlite', confirm: true }, id); } finally { quiescing = false; }
  }, async () => { await completeMigration(phone, completionDeps); finished = true; });
  ownedKeys.add(taskLock);
  let secondStarted = false;
  await assert.rejects(() => tasks.start(phone + '0', 'migration', async () => { secondStarted = true; }), error => error.status === 409 && error.code === 'session_storage_worker_migration_busy'); assertions++;
  check(!secondStarted && !await redis.exists(`unoapi-session-storage:task:lock:${phone}0`), 'second migration refused before touching its session');
  check(await redis.pTTL(workerLock) > 0, 'worker reservation expires on crash instead of becoming permanent garbage');
  const deadline = Date.now() + 30000;
  while (!finished && Date.now() < deadline) { const current = await tasks.status(phone, task.id); if (current.status === 'failed') throw new Error(current.error); await pause(); }
  check(finished, 'task and completion completed');
  if (interrupt) {
    check(JSON.parse(await redis.get(migrationCompletionKey(phone))).cleanup === 'pending', 'concurrent lifecycle pauses cleanup');
    await redis.del(taskLock); await completeMigration(phone, completionDeps);
  }
  const result = await tasks.status(phone, task.id);
  check(result.status === 'ready', 'migration ready independent of cleanup result');
  check(result.result.sourceCleanup.status === (diverge ? 'diverged' : 'ready'), 'cleanup receipt is accurate');
  check(result.result.sourcePreserved === diverge, 'source preservation is not simulated success');
  check(requests === (eligible ? 1 : 0), 'only previously active sessions resume once');
  check(await redis.type(legacyKey) === 'zset' && await source.zcard(legacyKey) === 1, 'legacy auxiliary ZSET is not deleted');
  check(await redis.get(foreignKey) === 'foreign session reference', 'foreign session untouched');
  check(await redis.exists(idKey) === 0 && await redis.exists(revKey) === 0, 'Redis ID shadow cleaned');
  check(db.getValue(idKey).toString() === 'UNO_ORIGINAL' && db.getValue(revKey).toString() === 'ZAPO_ORIGINAL', 'SQLite ID pair preserved');
  if (eligible) {
    check(db.getValue(data + 'after-cutover').toString() === 'new SQLite data', 'writes after resume survive cleanup');
    const live = JSON.parse(await redis.get(configKey)); check(live.sessionStorage.state === 'active' && await redis.get(statusKey) === 'online', 'descriptor tracks actual online event');
    check(!await publishOwnedSqliteConnectionState(redis, phone, live.sessionStorage, { key: socketLease, token: randomUUID() }, 'offline'), 'stale socket cannot overwrite online');
    check(!await publishOwnedSqliteConnectionState(redis, phone, { ...live.sessionStorage, generation: 99 }, { key: socketLease, token: socketToken }, 'offline'), 'old generation cannot change state');
    check(await publishOwnedSqliteConnectionState(redis, phone, live.sessionStorage, { key: socketLease, token: socketToken }, 'offline'), 'disconnect event persisted');
    check(JSON.parse(await redis.get(configKey)).sessionStorage.state === 'offline', 'descriptor returns offline');
  }
  if (diverge) {
    check(await redis.get(data + '1') === 'new-data-do-not-delete', 'changed content retained');
    check(await redis.pTTL(data + '204') > 600000, 'changed expiration retained');
    check(result.result.sourceCleanup.skippedMutated === 1 && result.result.sourceCleanup.skippedTtl === 1, 'divergence reasons measured');
  }
  // Real Lua scope guards: a new restore/generation must block every deletion.
  const plan = JSON.parse(await redis.get(migrationCompletionKey(phone)));
  plan.cleanup = 'running'; await set(migrationCompletionKey(phone), JSON.stringify(plan)); await set(migrationCompletionLock(phone), 'probe-lock');
  const guarded = data + 'guard'; await set(guarded, 'keep');
  const dump = await source.dumpBuffer(guarded), row = { key: guarded, sha1: createHash('sha1').update(dump).digest('hex'), expiresAt: -1 };
  const keys = [configKey, migrationCompletionLock(phone), `unoapi-session-storage:backup:${plan.backupId}`, migrationCompletionKey(phone), taskLock, guarded];
  const args = [String(plan.storage.generation), plan.storage.storageId, owner, 'probe-lock', plan.backupId, phone, 'unoapi:zapo:', JSON.stringify([row]), plan.taskId, plan.digest];
  const backupKey = `unoapi-session-storage:backup:${plan.backupId}`, backupRaw = await redis.get(backupKey);
  await redis.del(backupKey);
  await assert.rejects(() => source.eval(CLEAN_DEFERRED_SOURCE_BATCH_LUA, keys.length, ...keys, ...args), /backup_required/); assertions++;
  await set(backupKey, backupRaw);
  const foreignDump = await source.dumpBuffer(foreignKey), foreignRow = { key: foreignKey, sha1: createHash('sha1').update(foreignDump).digest('hex'), expiresAt: -1 };
  const foreignArgs = [...args]; foreignArgs[7] = JSON.stringify([foreignRow]);
  await assert.rejects(() => source.eval(CLEAN_DEFERRED_SOURCE_BATCH_LUA, keys.length, ...keys.slice(0, -1), foreignKey, ...foreignArgs), /scope_invalid/); assertions++;
  if (eligible) {
    // Simulate a crash after intent restoration, followed by manual suspension.
    // A later poll must not restore the old intent or dispatch again.
    const suspended = JSON.parse(await redis.get(configKey)); suspended.autoConnect = false;
    await set(configKey, JSON.stringify(suspended)); await redis.del(migrationCompletionLock(phone));
    await redis.del(socketLease); localClient = false;
    plan.resume = 'enabled'; plan.cleanup = 'pending'; await set(migrationCompletionKey(phone), JSON.stringify(plan));
    const previousRequests = requests;
    await completeMigration(phone, completionDeps);
    check(requests === previousRequests && JSON.parse(await redis.get(configKey)).autoConnect === false, 'manual suspension wins over crash replay');
    plan.resume = 'skipped'; plan.cleanup = 'running'; await set(migrationCompletionKey(phone), JSON.stringify(plan)); await set(migrationCompletionLock(phone), 'probe-lock');
  }
  await set(taskLock, 'new-restore');
  await assert.rejects(() => source.eval(CLEAN_DEFERRED_SOURCE_BATCH_LUA, keys.length, ...keys, ...args), /operation_in_progress/); assertions++;
  await redis.del(taskLock);
  const fresh = JSON.parse(await redis.get(configKey)); fresh.sessionStorage.generation++; await set(configKey, JSON.stringify(fresh));
  await assert.rejects(() => source.eval(CLEAN_DEFERRED_SOURCE_BATCH_LUA, keys.length, ...keys, ...args), /configuration_changed/); assertions++;
  check(await redis.get(guarded) === 'keep', 'changed generation never deletes');
  return { eligible, mobile, diverge, interrupt, requests, cleanupCalls, batches: result.result.sourceCleanup.batches };
}

(async () => {
  await redis.connect(); await source.connect(); root = await mkdtemp(join(tmpdir(), 'viper-migration-completion-'));
  const scenarios = [];
  for (const options of [{ eligible: true, mobile: false, diverge: false, interrupt: false }, { eligible: false, mobile: true, diverge: false, interrupt: false }, { eligible: true, mobile: false, diverge: true, interrupt: false }, { eligible: true, mobile: true, diverge: false, interrupt: true }]) scenarios.push(await scenario(options));
  console.log(JSON.stringify({ test: 'storage-migration-completion-lab', ok: true, assertions, scenarios, redis: 'real DEV', sqlite: 'real WAL', archive: 'real codec/readback; in-memory object transport', whatsapp: 'synthetic; no real connections or messages' }));
})().catch(error => { console.error(JSON.stringify({ test: 'storage-migration-completion-lab', ok: false, error: String(error.message).replace(/redis:\/\/\S+/g, '[redis]') })); process.exitCode = 1; }).finally(async () => {
  for (const db of databases) db.close(); closeAllSessionDatabases();
  if (redis.isOpen) { const keys = [...ownedKeys]; for (let i = 0; i < keys.length; i += 100) await redis.unlink(keys.slice(i, i + 100)); await redis.quit(); }
  source.disconnect();
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep)) await rm(root, { recursive: true, force: true });
});
