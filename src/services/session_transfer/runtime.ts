import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Redis from 'ioredis'
import { WaAuthRedisStore } from '@zapo-js/store-redis'
import { MobileDeviceError } from '../mobile_device_service'
import { MobileBackupTasks, BackupTask } from '../mobile_primary/backup_tasks'
import { encryptMobileBackup, decryptMobileBackup, BACKUP_MAX_BYTES } from '../mobile_primary/backup_archive'
import { BACKUP_DOMAINS, BACKUP_DATA_DOMAINS, BACKUP_UNO_DOMAINS, BackupMode, backupRecordKey, isMobileBackupKey } from '../mobile_primary/backup_manifest'
import { SessionTransferManifest, validateSessionTransfer } from './manifest'

export const SESSION_TASK_PREFIX = 'session-transfer:{v1}:task:'
const checkpoint = (phone: string) => `session-transfer:{v1}:completed:${phone}`
const fail = (code: string, status = 409): never => { throw new MobileDeviceError(status, code) }
const phoneCheck = (phone: string) => { if (!/^[1-9]\d{7,14}$/.test(phone)) fail('session_phone_invalid', 400) }

export async function createSessionTransfer() {
  const service = await import('../redis.js')
  const { ReloadAmqp } = await import('../reload_amqp.js')
  const { getConfigRedis } = await import('../config_redis.js')
  const { ZAPO_REDIS_KEY_PREFIX, UNOAPI_SERVER_NAME } = await import('../../defaults.js')
  const { resolveZapoRedisKeyPrefix, createZapoStore } = await import('../zapo/zapo_store.js')
  const { clearZapoSession } = await import('../zapo/zapo_session_cleanup.js')
  const prefix = resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX)
  const versionCheck = () => {
    if (require('zapo-js/package.json').version !== '1.9.0' || JSON.parse(readFileSync(join(dirname(require.resolve('@zapo-js/store-redis')), '../package.json'), 'utf8')).version !== '1.3.0') fail('session_backup_incompatible', 400)
  }
  const config = async (phone: string) => {
    phoneCheck(phone)
    const value = await service.getConfig(phone)
    if (!value || value.provider !== 'zapo' || value.mobilePrimaryDraftId || !value.useRedis) fail('session_backup_requires_linked_redis_session')
    return value
  }
  async function run<T>(action: (redis: Redis) => Promise<T>) {
    versionCheck()
    const redis = new Redis(process.env.REDIS_URL || '', { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
    redis.on('error', () => {})
    try { await redis.connect(); return await action(redis) } finally { redis.disconnect() }
  }
  async function owned<T>(redis: Redis, phone: string, action: (key: string, token: string, renew: () => Promise<void>) => Promise<T>) {
    const key = `unoapi-lease:zapo-session:${phone}`, token = randomUUID()
    if (await redis.set(key, token, 'PX', 120000, 'NX') !== 'OK') fail('session_backup_waiting_disconnect')
    const renew = async () => { if (Number(await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) end return 0", 1, key, token)) !== 1) fail('session_backup_lease_lost') }
    try { return await action(key, token, renew) } finally { await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token) }
  }
  async function keys(redis: Redis, phone: string, mode: BackupMode) {
    const result = new Set<string>()
    const scopes: Array<{ domain: string; base: string; namespace?: 'uno' }> = [...BACKUP_DOMAINS, ...(mode === 'complete' ? BACKUP_DATA_DOMAINS : [])].map(domain => ({ domain, base: prefix }))
    if (mode === 'complete') scopes.push(...BACKUP_UNO_DOMAINS.map(domain => ({ domain, base: 'unoapi-', namespace: 'uno' as const })))
    for (const scope of scopes) {
      const base = `${scope.base}${scope.domain}:${phone}`
      if (await redis.exists(base)) result.add(base)
      let cursor = '0'
      do {
        const page = await redis.scan(cursor, 'MATCH', base + ':*', 'COUNT', 200); cursor = page[0]
        for (const key of page[1]) if (isMobileBackupKey(key.slice(scope.base.length), phone, mode, scope.namespace)) result.add(key)
        if (result.size > 10000) fail('mobile_backup_too_large', 413)
      } while (cursor !== '0')
    }
    return [...result].sort()
  }
  const exportSession = async (phone: string, body: any) => run(async redis => {
    const current = await config(phone)
    await service.setConfig(phone, { autoConnect: false })
    await new ReloadAmqp(getConfigRedis).run(phone)
    for (let attempt = 0; attempt < 50 && await redis.exists(`unoapi-lease:zapo-session:${phone}`); attempt++) await new Promise(resolve => setTimeout(resolve, 200))
    return owned(redis, phone, async (lease, token, renew) => {
      const auth = await new WaAuthRedisStore({ redis, keyPrefix: prefix, sessionId: phone }).load()
      if (!auth?.meJid || auth.deviceInfo) return fail('session_backup_registered_linked_required')
      const snapshot: SessionTransferManifest = { kind: 'linked-session', version: 1, zapo: '1.9.0', redisStore: '1.3.0', phone, name: String(current.name || phone).slice(0, 80), identityJid: auth.meJid, mode: body.mode, createdAt: new Date().toISOString(), records: [] }
      let size = 0
      for (const key of await keys(redis, phone, body.mode)) {
        const captured = Date.now(), ttl = await redis.pttl(key)
        if (ttl === -2) continue
        const dump = await redis.dumpBuffer(key)
        if (!dump) fail('session_backup_state_changed')
        const namespace = key.startsWith(prefix) ? undefined : 'uno' as const
        const record = { key: key.slice(namespace ? 'unoapi-'.length : prefix.length), dump: dump!.toString('base64'), ...(namespace ? { namespace } : {}), ...(ttl >= 0 ? { expiresAt: captured + ttl } : {}) }
        size += record.key.length + record.dump.length
        if (size > BACKUP_MAX_BYTES / 2 - 262144) fail('mobile_backup_too_large', 413)
        snapshot.records.push(record)
        if (snapshot.records.length % 100 === 0) await renew()
      }
      validateSessionTransfer(snapshot, prefix)
      const archive = await encryptMobileBackup(snapshot, body.password)
      await renew()
      const raw = await redis.get(service.configKey(phone)), latest = raw && JSON.parse(raw)
      if (!latest || latest.autoConnect !== false || latest.provider !== 'zapo' || latest.mobilePrimaryDraftId) fail('session_backup_state_changed')
      if (Number(await redis.eval("if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('GET',KEYS[2]) ~= ARGV[2] then return 0 end redis.call('SET',KEYS[3],ARGV[3]) return 1", 3, lease, service.configKey(phone), checkpoint(phone), token, raw!, snapshot.createdAt)) !== 1) fail('session_backup_state_changed')
      return { archive, fileName: `sessao-${phone}-${Date.now()}.vipersession` }
    })
  })
  const tasks = new MobileBackupTasks({ redis: await service.getRedis(), exists: config, export: exportSession }, SESSION_TASK_PREFIX)
  return {
    tasks,
    list: () => run(async redis => {
      const states: BackupTask[] = []; let cursor = '0'
      do {
        const page = await redis.scan(cursor, 'MATCH', SESSION_TASK_PREFIX + '*', 'COUNT', 100); cursor = page[0]
        for (const key of page[1]) {
          const phone = key.slice(SESSION_TASK_PREFIX.length)
          if (/^[1-9]\d{7,14}$/.test(phone)) { const state = await tasks.status(phone); if (state) states.push(state) }
        }
      } while (cursor !== '0')
      return { tasks: states }
    }),
    eligibility: (phone: string) => run(async redis => ({ eligible: (await config(phone)).autoConnect === false && !!await redis.get(checkpoint(phone)) })),
    restore: (body: any) => run(async redis => {
      if (!body || body.confirmOriginOffline !== true || Object.keys(body).some(k => !['archive', 'password', 'confirmOriginOffline'].includes(k))) fail('mobile_restore_confirmation_required', 400)
      const snapshot = await decryptMobileBackup(body.archive, body.password)
      validateSessionTransfer(snapshot, prefix)
      const phone = snapshot.phone
      return owned(redis, phone, async (lease, token, renew) => {
        if (await service.getConfig(phone) || await redis.hexists('mobile-primary:{v1}:drafts', phone) || (await keys(redis, phone, 'complete')).length) fail('mobile_restore_destination_exists')
        const stage = `session_transfer_stage:${randomUUID().replace(/-/g, '')}:`, staged: string[] = []
        try {
          const records = snapshot.records.filter(record => record.expiresAt === undefined || record.expiresAt > Date.now())
          for (const record of records) {
            const key = stage + backupRecordKey(record, prefix)
            await redis.restore(key, 300000, Buffer.from(record.dump, 'base64')); staged.push(key)
            if (staged.length % 100 === 0) await renew()
          }
          const auth = await new WaAuthRedisStore({ redis, keyPrefix: stage + prefix, sessionId: phone }).load()
          if (!auth || auth.deviceInfo || auth.meJid !== snapshot.identityJid) fail('mobile_backup_identity_mismatch', 400)
          await renew()
          const targetConfig = { provider: 'zapo', server: UNOAPI_SERVER_NAME, name: snapshot.name, useRedis: true, useS3: true, autoConnect: false, webhooks: [] }
          const expiry = Object.fromEntries(records.filter(r => r.expiresAt !== undefined).map(r => [backupRecordKey(r, prefix), r.expiresAt]))
          const targetKeys = [lease, service.configKey(phone), service.sessionPhoneIndexKey(), ...records.flatMap(r => [stage + backupRecordKey(r, prefix), backupRecordKey(r, prefix)])]
          const result = await redis.eval(`
            if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[2]) ~= 0 or redis.call('HEXISTS','mobile-primary:{v1}:drafts',ARGV[3]) == 1 then return 0 end
            local kind = redis.call('TYPE',KEYS[3]).ok
            if kind ~= 'none' and kind ~= 'set' then return 0 end
            for i=4,#KEYS,2 do if redis.call('EXISTS',KEYS[i]) ~= 1 or redis.call('EXISTS',KEYS[i+1]) ~= 0 then return 0 end end
            local expiry=cjson.decode(ARGV[4])
            for i=4,#KEYS,2 do redis.call('RENAME',KEYS[i],KEYS[i+1]); if expiry[KEYS[i+1]] then redis.call('PEXPIREAT',KEYS[i+1],expiry[KEYS[i+1]]) else redis.call('PERSIST',KEYS[i+1]) end end
            redis.call('SET',KEYS[2],ARGV[2]); redis.call('SADD',KEYS[3],ARGV[3]); redis.call('PUBLISH','unoapi-config:update',ARGV[3]); return 1`, targetKeys.length, ...targetKeys, token, JSON.stringify(targetConfig), phone, JSON.stringify(expiry))
          if (Number(result) !== 1) fail('mobile_restore_destination_exists')
          return { phone, status: 'disconnected', restored: true }
        } finally { for (let i = 0; i < staged.length; i += 100) await redis.del(...staged.slice(i, i + 100)) }
      })
    }),
    remove: (phone: string, body: any) => run(async redis => {
      if (!body || body.phone !== phone || body.confirm !== true || body.backupValidated !== true || Object.keys(body).some(k => !['phone', 'confirm', 'backupValidated'].includes(k))) fail('mobile_removal_confirmation_required', 400)
      phoneCheck(phone)
      return owned(redis, phone, async (_lease, _token, renew) => {
        const current = await config(phone)
        if (current.autoConnect !== false || !await redis.get(checkpoint(phone))) fail('mobile_transfer_backup_suspension_required')
        // Fence reactivation at the destructive boundary, not merely when opening the modal.
        const marked = await redis.eval(`
          if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[3]) ~= 1 then return 0 end
          local raw=redis.call('GET',KEYS[2]); if not raw then return 0 end
          local cfg=cjson.decode(raw)
          if cfg.autoConnect ~= false or cfg.provider ~= 'zapo' or cfg.mobilePrimaryDraftId then return 0 end
          cfg.sessionTransferDeleting=true
          redis.call('SET',KEYS[2],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',ARGV[2]); return 1`, 3, _lease, service.configKey(phone), checkpoint(phone), _token, phone)
        if (Number(marked) !== 1) fail('mobile_transfer_backup_suspension_required')
        await renew()
        const store = createZapoStore({ useRedis: true, baseStore: current.baseStore, redisUrl: process.env.REDIS_URL, redisKeyPrefix: prefix })
        try { await clearZapoSession(store.session(phone)) } finally { await store.destroy() }
        await service.delConfig(phone); await service.delSessionTransientKeys(phone); await service.delSessionStatus(phone)
        await redis.del(checkpoint(phone))
      })
    }),
  }
}
