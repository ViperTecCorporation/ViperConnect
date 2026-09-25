import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Redis from 'ioredis'
import { WaAuthRedisStore } from '@zapo-js/store-redis'
import { MobileDeviceService, MobileDeviceError, MOBILE_DRAFTS_KEY } from '../mobile_device_service'
import { RegistrationVault } from './registration_vault'
import { REGISTRATION_PREFIX } from './registration_service'
import { convertWhalibmobCredentials } from './whalibmob_credentials'
import { BACKUP_DOMAINS, isMobileBackupKey, validateMobileBackup, MobileBackupManifest, backupRegistration } from './backup_manifest'
import { BACKUP_MAX_BYTES, decryptMobileBackup, encryptMobileBackup, validateBackupPassword } from './backup_archive'

export const COMMIT_MOBILE_BACKUP = `
if redis.call('GET', KEYS[5]) ~= ARGV[5] then return 0 end
local dt = redis.call('TYPE', KEYS[1]).ok
local it = redis.call('TYPE', KEYS[4]).ok
if (dt ~= 'none' and dt ~= 'hash') or (it ~= 'none' and it ~= 'set') then return 0 end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 or redis.call('HLEN', KEYS[1]) >= 100 then return 0 end
if redis.call('EXISTS', KEYS[2], KEYS[3]) ~= 0 then return 0 end
for i = 6, #KEYS, 2 do
  if redis.call('EXISTS', KEYS[i]) ~= 1 or redis.call('EXISTS', KEYS[i+1]) ~= 0 then return 0 end
end
for i = 6, #KEYS, 2 do redis.call('RENAME', KEYS[i], KEYS[i+1]); redis.call('PERSIST', KEYS[i+1]) end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('PUBLISH', 'unoapi-config:update', ARGV[1])
return 1`

// One expensive encryption/import per web process. The session lock also spans replicas.
let busy = false
export async function createMobileBackupService() {
  const redisService = await import('../redis.js')
  const { getConfigRedis } = await import('../config_redis.js')
  const { ReloadAmqp } = await import('../reload_amqp.js')
  const { resolveZapoRedisKeyPrefix } = await import('../zapo/zapo_store.js')
  const { ZAPO_REDIS_KEY_PREFIX } = await import('../../defaults.js')
  const prefix = resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX)
  const drafts = new MobileDeviceService()
  const fail = (code: string, status = 409): never => { throw new MobileDeviceError(status, code) }

  async function run<T>(action: (redis: Redis, vault: RegistrationVault) => Promise<T>): Promise<T> {
    if (process.env.UNOAPI_MOBILE_PRIMARY_LAB !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') return fail('mobile_backup_disabled', 404)
    if (require('zapo-js/package.json').version !== '1.9.0' || JSON.parse(readFileSync(join(dirname(require.resolve('@zapo-js/store-redis')), '../package.json'), 'utf8')).version !== '1.3.0') return fail('mobile_backup_incompatible', 400)
    if (busy) return fail('mobile_backup_busy')
    busy = true
    let redis: Redis | undefined
    try {
      const vault = new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || '')
      redis = new Redis(process.env.REDIS_URL || '', { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
      redis.on('error', () => { /* The controller returns a sanitized error, never connection credentials. */ })
      await redis.connect()
      return await action(redis, vault)
    } finally { redis?.disconnect(); busy = false }
  }

  async function scopedKeys(redis: Redis, phone: string): Promise<string[]> {
    const keys = new Set<string>()
    // Exact base key plus descendants; never allow a partial phone match.
    for (const domain of BACKUP_DOMAINS) {
      const base = `${prefix}${domain}:${phone}`
      if (await redis.exists(base)) keys.add(base)
      let cursor = '0'
      do {
        const page = await redis.scan(cursor, 'MATCH', `${base}:*`, 'COUNT', 200)
        cursor = page[0]
        for (const key of page[1]) if (isMobileBackupKey(key.slice(prefix.length), phone)) keys.add(key)
        if (keys.size > 10000) return fail('mobile_backup_too_large', 413)
      } while (cursor !== '0')
    }
    return [...keys].sort()
  }

  async function lock<T>(redis: Redis, phone: string, action: (key: string, token: string, renew: () => Promise<void>) => Promise<T>): Promise<T> {
    const key = `unoapi-lease:zapo-session:${phone}`, token = randomUUID()
    if (await redis.set(key, token, 'PX', 120000, 'NX') !== 'OK') return fail('mobile_backup_waiting_disconnect')
    const renew = async () => {
      if (Number(await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) end return 0", 1, key, token)) !== 1) fail('mobile_backup_lease_lost')
    }
    try { return await action(key, token, renew) }
    finally { await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token) }
  }

  return {
    export: async (id: string, body: any) => {
      validateBackupPassword(body?.password)
      if (body.confirmSuspend !== true || Object.keys(body).some(key => !['password', 'confirmSuspend'].includes(key))) return fail('mobile_backup_confirmation_required', 400)
      return run(async (redis, vault) => {
        const draft = await drafts.get(id)
        const raw = await redis.get(REGISTRATION_PREFIX + id)
        const state: any = raw && vault.open(id, raw)
        const phone = state?.canonicalPhone
        if (state?.status !== 'registered' || !/^[1-9]\d{7,14}$/.test(phone || '')) return fail('mobile_registration_required')
        const config = await redisService.getConfig(phone)
        if (!config?.mobilePrimaryImported || config.mobilePrimaryDraftId !== id || config.server !== 'mobile_lab' || config.provider !== 'zapo' || !config.useRedis || config.mobilePrimaryDeleting) return fail('mobile_backup_requires_imported_redis_device')
        // Suspension preserves webhooks and credentials; no deregister/logout is invoked.
        await redisService.setConfig(phone, { autoConnect: false })
        await new ReloadAmqp(getConfigRedis).run(phone)
        for (let attempt = 0; attempt < 50 && await redis.exists(`unoapi-lease:zapo-session:${phone}`); attempt++) await new Promise(resolve => setTimeout(resolve, 200))
        return lock(redis, phone, async (_key, _token, renew) => {
          await drafts.get(id)
          const snapshot: MobileBackupManifest = { version: 1, zapo: '1.9.0', redisStore: '1.3.0', prefix, createdAt: new Date().toISOString(), device: { phone, name: draft.name, platform: draft.platform, accountType: draft.accountType }, registration: backupRegistration(state), records: [] }
          const epochKey = `mobile-primary:{v1}:companions:${id}`
          const epoch = await redis.get(epochKey)
          if (epoch) snapshot.companionEpoch = vault.open(epochKey, epoch)
          let size = 0
          for (const key of await scopedKeys(redis, phone)) {
            const dump = await redis.dumpBuffer(key)
            if (!dump) return fail('mobile_backup_state_changed')
            const record = { key: key.slice(prefix.length), dump: dump.toString('base64') }
            size += record.key.length + record.dump.length
            if (size > BACKUP_MAX_BYTES / 2 - 262144) return fail('mobile_backup_too_large', 413)
            snapshot.records.push(record)
            if (snapshot.records.length % 100 === 0) await renew()
          }
          validateMobileBackup(snapshot, prefix)
          await renew()
          const latest = await redisService.getConfig(phone)
          if (latest?.autoConnect !== false || latest.mobilePrimaryDraftId !== id || latest.mobilePrimaryDeleting) return fail('mobile_backup_state_changed')
          return { fileName: `dispositivo-${phone}-${Date.now()}.viperdevice`, archive: await encryptMobileBackup(snapshot, body.password), sourceSuspended: true }
        })
      })
    },
    restore: async (body: any, actor: string) => {
      if (!body || body.confirmOriginOffline !== true || Object.keys(body).some(key => !['archive', 'password', 'confirmOriginOffline'].includes(key))) return fail('mobile_restore_confirmation_required', 400)
      return run(async (redis, vault) => {
        const snapshot = await decryptMobileBackup(body.archive, body.password)
        validateMobileBackup(snapshot, prefix)
        const { phone } = snapshot.device
        const credentials = await convertWhalibmobCredentials(snapshot.registration.store, { expectedCanonicalPhone: phone, advSecretKey: Buffer.from(snapshot.registration.advSecret, 'base64') })
        return lock(redis, phone, async (leaseKey, token, renew) => {
          if (await redisService.getConfig(phone) || (await drafts.list()).some(d => d.phone === phone) || (await scopedKeys(redis, phone)).length) return fail('mobile_restore_destination_exists')
          const id = randomUUID(), stage = `mobile_backup_stage:${id.replace(/-/g, '')}:`, staged: string[] = []
          try {
            for (const record of snapshot.records) {
              const key = stage + prefix + record.key
              await redis.restore(key, 300000, Buffer.from(record.dump, 'base64'))
              staged.push(key)
              if (staged.length % 100 === 0) await renew()
            }
            const auth = await new WaAuthRedisStore({ redis, keyPrefix: stage + prefix, sessionId: phone }).load()
            if (!auth || auth.meJid !== credentials.meJid || auth.deviceInfo?.os !== credentials.deviceInfo?.os || auth.deviceInfo?.business !== credentials.deviceInfo?.business || !Buffer.from(auth.noiseKeyPair.pubKey).equals(Buffer.from(credentials.noiseKeyPair.pubKey)) || !Buffer.from(auth.registrationInfo.identityKeyPair.pubKey).equals(Buffer.from(credentials.registrationInfo.identityKeyPair.pubKey))) return fail('mobile_backup_identity_mismatch', 400)
            const draft = { ...snapshot.device, id, connectionMode: 'mobile_primary', state: 'draft', createdAt: new Date().toISOString(), createdBy: actor }
            const config = { provider: 'zapo', server: 'mobile_lab', name: draft.name, useRedis: true, useS3: true, autoConnect: false, markOnlineOnConnect: false, webhooks: [], mobilePrimaryDraftId: id, mobilePrimaryImported: true }
            const keys = [MOBILE_DRAFTS_KEY, REGISTRATION_PREFIX + id, redisService.configKey(phone), redisService.sessionPhoneIndexKey(), leaseKey, ...snapshot.records.flatMap((record: any) => [stage + prefix + record.key, prefix + record.key])]
            if (snapshot.companionEpoch) {
              const epochKey = `mobile-primary:{v1}:companions:${id}`, stagingKey = stage + 'companions'
              await redis.set(stagingKey, vault.seal(epochKey, snapshot.companionEpoch), 'EX', 300)
              staged.push(stagingKey)
              keys.push(stagingKey, epochKey)
            }
            await renew()
            const result = await redis.eval(COMMIT_MOBILE_BACKUP, keys.length, ...keys, phone, JSON.stringify(draft), vault.seal(id, backupRegistration(snapshot.registration)), JSON.stringify(config), token)
            if (Number(result) !== 1) return fail('mobile_restore_destination_exists')
            return { device: draft, status: 'disconnected', restored: true }
          } finally {
            // Only random staging keys from this import; renamed live keys are never touched.
            for (let offset = 0; offset < staged.length; offset += 100) await redis.del(...staged.slice(offset, offset + 100))
          }
        })
      })
    },
  }
}
