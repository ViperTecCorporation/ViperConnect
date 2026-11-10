/* Local lab only. Copies one session into an EMPTY scope, never uses production credentials. */
const Redis = require('ioredis')
const { randomUUID } = require('node:crypto')
const { createInterface } = require('node:readline')
async function main() {
  if (process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') throw new Error('isolated_mobile_lab_required')
  const source = new URL(process.env.STORAGE_FIXTURE_SOURCE || '')
  if (source.hostname !== 'host.docker.internal' || source.port !== '16391' || source.pathname !== '/fixture') throw new Error('ssh_tunnel_source_required')
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
  let meta, count = 0, complete
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(18 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error('export_unavailable')
    const lines = createInterface({ input: require('node:stream').Readable.fromWeb(response.body), crlfDelay: Infinity })
    let pipe = redis.pipeline(), pending = 0
    const flush = async () => { if (!pending) return; const result = await pipe.exec(); if (result.some(([e]) => e)) throw new Error('restore_failed'); pipe = redis.pipeline(); pending = 0 }
    for await (const line of lines) {
      if (line.length > 16 * 1024 * 1024) throw new Error('record_limit')
      const row = JSON.parse(line)
      if (row.kind === 'meta') {
        if (meta || !/^\d{8,15}$/.test(row.phone)) throw new Error('invalid_meta')
        meta = row
        const patterns = [`unoapi-*:${meta.phone}*`, `${meta.prefix}*${meta.phone}*`]
        for (const pattern of patterns) {
          let cursor = '0'
          do { const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000); cursor = page[0]; if (page[1].length) throw new Error('fixture_scope_not_empty') } while (cursor !== '0')
        }
        // A durable safety marker is written BEFORE the first credential/history record.
        await redis.set(`unoapi-config:${meta.phone}`, JSON.stringify({ provider: 'zapo', server: 'mobile_lab', name: meta.config.name, connectionType: meta.config.connectionType,
          zapoWebClientProfile: meta.config.zapoWebClientProfile, autoConnect: false, useRedis: true, useS3: true, webhooks: [], authToken: randomUUID(),
          sessionStorage: { backend: 'redis', storageId: randomUUID(), owner: 'mobile_lab', generation: 1, state: 'offline', fixture: true } }))
        await redis.sadd('unoapi-sessions:index', meta.phone)
        await redis.set(`unoapi-status:${meta.phone}`, 'offline')
      } else if (row.kind === 'record') {
        if (!meta || typeof row.key !== 'string' || typeof row.dump !== 'string') throw new Error('invalid_record')
        const native = row.key.startsWith(meta.prefix) && row.key.slice(meta.prefix.length).split(':').find(p => /^\d{8,16}$/.test(p)) === meta.phone
        const compat = new RegExp(`^unoapi-[^:]+:${meta.phone}(?::|$)`).test(row.key) && !/^unoapi-(config|status|auth|lease|webhook-cb|session-webhooks)(:|-)/.test(row.key)
        if (!native && !compat) throw new Error('foreign_scope')
        const ttl = row.expiresAt === null ? 0 : row.expiresAt - Date.now()
        if (row.expiresAt === null || ttl > 0) { pipe.restore(row.key, Math.max(0, Math.trunc(ttl)), Buffer.from(row.dump, 'base64')); pending++ }
        count++; if (pending >= 100) await flush()
      } else if (row.kind === 'complete') { complete = row }
      else throw new Error('invalid_frame')
    }
    await flush()
    if (!meta || !complete || complete.count !== count) throw new Error('export_incomplete')
    await redis.set(`unoapi-session-storage:fixture-import:${meta.phone}`, JSON.stringify({ ...complete, sampledAt: meta.sampledAt, importedAt: Date.now(), liveReadNotAtomicSnapshot: true, externalEffects: false }))
    console.log(JSON.stringify({ phone: meta.phone, importedRecords: count, estimatedRedisMemoryBytes: complete.estimatedRedisMemoryBytes, realSends: 0, atomicProductionBackup: false }))
  } finally { await redis.quit() }
}
main().then(() => process.exit(0)).catch(() => { console.error('fixture_import_failed_scope_preserved_for_inspection'); process.exit(1) })
