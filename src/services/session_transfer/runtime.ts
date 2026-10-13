import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Redis from 'ioredis'
import { WaAuthRedisStore } from '@zapo-js/store-redis'
import { MobileDeviceError } from '../mobile_device_service'
import { MobileBackupTasks, BackupTask } from '../mobile_primary/backup_tasks'
import { decryptMobileBackup } from '../mobile_primary/backup_archive'
import { BackupMode, backupRecordKey } from '../mobile_primary/backup_manifest'
import { validateSessionTransfer } from './manifest'
import { requestRestoredConnection } from '../mobile_primary/restored_connection'
import { Readable } from 'node:stream'
import { encryptSessionStream, decryptSessionStream, backupLines } from './archive_stream'
import { sessionKeys, sessionRecords } from './stream_records'
import { restoreStagedStream, validateStreamMeta, StreamSessionMeta } from './stream_restore'
import { recoverBackupConnection } from './backup_recovery'
import { MultipartSessionRestore } from './multipart_restore'

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
  const { amqpPublish } = await import('../../amqp.js')
  const { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_MEDIA } = await import('../../defaults.js')
  const prefix = resolveZapoRedisKeyPrefix(ZAPO_REDIS_KEY_PREFIX)
  const versionCheck = () => {
    if (JSON.parse(readFileSync(require.resolve('zapo-js/package.json'), 'utf8')).version !== '1.9.0' || JSON.parse(readFileSync(join(dirname(require.resolve('@zapo-js/store-redis')), '../package.json'), 'utf8')).version !== '1.3.0') fail('session_backup_incompatible', 400)
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
    for await (const key of sessionKeys(redis, prefix, phone, mode)) return [key]
    return []
  }
  const backupStorage = async (phone: string) => {
    const value = await getConfigRedis(phone)
    return (await value.getStore(phone, value)).mediaStore
  }
  const exportSession = async (phone: string, body: any, heartbeat?: () => Promise<void>) => run(async redis => {
    const current = await config(phone)
    const storage = await backupStorage(phone)
    const objectKey = `session-backups/${phone}/${randomUUID()}.vipersession`
    let complete = false
    try {
    await service.setConfig(phone, { autoConnect: false, sessionTransferBackupId: objectKey })
    await redis.del(checkpoint(phone))
    await new ReloadAmqp(getConfigRedis).run(phone)
    for (let attempt = 0; attempt < 50 && await redis.exists(`unoapi-lease:zapo-session:${phone}`); attempt++) await new Promise(resolve => setTimeout(resolve, 200))
    const result = await owned(redis, phone, async (lease, token, renew) => {
      const auth = await new WaAuthRedisStore({ redis, keyPrefix: prefix, sessionId: phone }).load()
      if (!auth?.meJid || auth.deviceInfo) return fail('session_backup_registered_linked_required')
      const snapshot: StreamSessionMeta = { kind: 'linked-session', version: 2, zapo: '1.9.0', redisStore: '1.3.0', phone, name: String(current.name || phone).slice(0, 80), identityJid: auth.meJid, mode: body.mode, createdAt: new Date().toISOString() }
      validateStreamMeta(snapshot)
      const alive = async () => { await renew(); await heartbeat?.() }
      const encrypted = encryptSessionStream(snapshot, sessionRecords(redis, prefix, phone, body.mode, alive), body.password)
      const stream = Readable.from(encrypted)
      // Existing shared media storage supports S3/MinIO/Swarm; Redis holds metadata only.
      try {
        if (!await storage.saveMediaStream(objectKey, stream, 'application/octet-stream', false, 0)) fail('session_backup_storage_failed', 503)
      } finally { stream.destroy(); await encrypted.return(undefined) }
      await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_MEDIA, phone, { fileName: objectKey }, { delay: 86400000, type: 'topic' })
      await renew()
      const raw = await redis.get(service.configKey(phone)), latest = raw && JSON.parse(raw)
      if (!latest || latest.autoConnect !== false || latest.provider !== 'zapo' || latest.mobilePrimaryDraftId || latest.sessionTransferBackupId !== objectKey) fail('session_backup_state_changed')
      if (Number(await redis.eval("if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('GET',KEYS[2]) ~= ARGV[2] then return 0 end; local cfg=cjson.decode(ARGV[2]); cfg.sessionTransferBackupId=nil; redis.call('SET',KEYS[2],cjson.encode(cfg)); redis.call('SET',KEYS[3],ARGV[3]); return 1", 3, lease, service.configKey(phone), checkpoint(phone), token, raw!, snapshot.createdAt)) !== 1) fail('session_backup_state_changed')
      return { objectKey, fileName: `sessao-${phone}-${Date.now()}.vipersession` }
    })
    complete = true
    return result
    } catch (error) {
      // Restore only the previous auto-connect state, never enable a session that
      // was already suspended. A successful migration backup stays offline.
      await recoverBackupConnection(redis, service.configKey(phone), phone, objectKey, current.autoConnect,
        () => requestRestoredConnection(phone, value => new ReloadAmqp(getConfigRedis).run(value)))
      throw error
    } finally { if (!complete) await storage.removeMedia(objectKey).catch(() => {}) }
  })
  const tasks = new MobileBackupTasks({ redis: await service.getRedis(), exists: config, export: exportSession }, SESSION_TASK_PREFIX)
  const api = {
    tasks,
    download: async (phone: string, task: string) => {
      const result = await tasks.download(phone, task)
      return result.objectKey ? { fileName: result.fileName, streamed: true } : result
    },
    downloadStream: async (phone: string, task: string) => {
      const result = await tasks.download(phone, task)
      const stream = result.objectKey ? await (await backupStorage(phone)).downloadMediaStream(result.objectKey) : Readable.from([result.archive || ''])
      if (!stream) fail('mobile_backup_expired', 410)
      return { stream: stream!, fileName: result.fileName }
    },
    restoreStream: async (source: AsyncIterable<Buffer | string>) => {
      const lines = backupLines(source)[Symbol.asyncIterator]()
      try {
        const first = await lines.next()
        if (first.done || Buffer.byteLength(first.value) > 4096) fail('mobile_restore_confirmation_required', 400)
        let input: any
        try { input = JSON.parse(first.value) } catch { return fail('mobile_restore_confirmation_required', 400) }
        if (!input || input.confirmOriginOffline !== true || Object.keys(input).sort().join(',') !== 'confirmOriginOffline,password') fail('mobile_restore_confirmation_required', 400)
        const remainder = async function* () { for (;;) { const next = await lines.next(); if (next.done) return; yield Buffer.from(next.value + '\n') } }
        const frames = decryptSessionStream(remainder(), input.password)[Symbol.asyncIterator]()
        try {
          const head = await frames.next()
          if (head.done || head.value.kind !== 'meta') fail('session_backup_incompatible', 400)
          const meta = head.value.value; validateStreamMeta(meta)
          const restored = await run(redis => owned(redis, meta.phone, async (lease, token, renew) => {
            if (await service.getConfig(meta.phone) || await redis.hexists('mobile-primary:{v1}:drafts', meta.phone)) fail('mobile_restore_destination_exists')
            for await (const _key of sessionKeys(redis, prefix, meta.phone, 'complete', renew)) fail('mobile_restore_destination_exists')
            return restoreStagedStream(redis, meta, { [Symbol.asyncIterator]: () => frames }, prefix, {
              lease, token, renew, configKey: service.configKey(meta.phone), indexKey: service.sessionPhoneIndexKey(),
              config: { provider: 'zapo', server: UNOAPI_SERVER_NAME, name: meta.name, useRedis: true, useS3: true, autoConnect: true, webhooks: [] },
              identity: async stagePrefix => { const auth = await new WaAuthRedisStore({ redis, keyPrefix: stagePrefix, sessionId: meta.phone }).load(); return !!auth && !auth.deviceInfo && auth.meJid === meta.identityJid },
            })
          }))
          return { ...restored, ...await requestRestoredConnection(meta.phone, value => new ReloadAmqp(getConfigRedis).run(value)) }
        } finally { await frames.return?.(undefined) }
      } finally { await lines.return?.(undefined) }
    },
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
      const restored = await owned(redis, phone, async (lease, token, renew) => {
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
          const targetConfig = { provider: 'zapo', server: UNOAPI_SERVER_NAME, name: snapshot.name, useRedis: true, useS3: true, autoConnect: true, webhooks: [] }
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
          return { phone, restored: true }
        } finally { for (let i = 0; i < staged.length; i += 100) await redis.del(...staged.slice(i, i + 100)) }
      })
      return { ...restored, ...await requestRestoredConnection(phone, phone => new ReloadAmqp(getConfigRedis).run(phone)) }
    }),
    remove: (phone: string, body: any) => run(async redis => {
      if (body && typeof body.phone === 'string') body = { ...body, phone: body.phone.trim() }
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
        await service.delConfig(phone, true); await service.delSessionTransientKeys(phone); await service.delSessionStatus(phone)
        await redis.del(checkpoint(phone))
      })
    }),
  }
  const multipart = new MultipartSessionRestore({
    redis: await service.getRedis(), restore: source => api.restoreStream(source),
    storage: async () => {
      const { getConfigByEnv } = await import('../config_by_env.js')
      const { getDataStoreRedis } = await import('../data_store_redis.js')
      const { getMediaStoreS3 } = await import('../media_store_s3.js')
      const { getMediaStoreFile } = await import('../media_store_file.js')
      const uploadPhone = 'session-transfer-upload', config = await getConfigByEnv(uploadPhone)
      return (config.useS3 ? getMediaStoreS3 : getMediaStoreFile)(uploadPhone, config, getDataStoreRedis)
    },
    scheduleRemoval: key => amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_MEDIA, 'session-transfer-upload', { fileName: key }, { delay: 86400000, type: 'topic' }),
  })
  return { ...api, multipart }
}
