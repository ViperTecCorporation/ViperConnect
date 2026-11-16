/* Read-only production exporter. No WaClient, config writes, leases, logout or replay.
 * Run in a supervised, temporary docker exec; expose only through an SSH tunnel.
 * Output is PRIVATE: never save in the checkout or print the response to logs. */
const http = require('node:http')
const { once } = require('node:events')
const Redis = require('ioredis')
const phone = process.env.STORAGE_FIXTURE_PHONE
if (!/^[1-9]\d{7,14}$/.test(phone || '')) throw new Error('fixture_phone_required')
const prefix = (!process.env.ZAPO_REDIS_KEY_PREFIX || process.env.ZAPO_REDIS_KEY_PREFIX === 'unoapi-zapo:') ? 'unoapi:zapo:' : process.env.ZAPO_REDIS_KEY_PREFIX
const own = key => key.startsWith(prefix)
  ? key.slice(prefix.length).split(':').find(part => /^\d{8,16}$/.test(part)) === phone
  : new RegExp(`^unoapi-[^:]+:${phone}(?::|$)`).test(key) && !/^unoapi-(config|status|auth|lease|webhook-cb|session-webhooks)(:|-)/.test(key)
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 30000 })
redis.on('error', () => {})
let active = false, completed = false
const server = http.createServer(async (req, res) => {
  // The host gateway is the only accepted peer. Do not publish a Docker port.
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '')
  if (peer !== process.env.STORAGE_FIXTURE_GATEWAY || req.method !== 'GET' || req.url !== '/fixture' || active || completed) { res.writeHead(403); res.end(); return }
  active = true
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  const line = async value => { if (!res.write(JSON.stringify(value) + '\n')) await once(res, 'drain') }
  let count = 0, bytes = 0, memoryBytes = 0, cursor = '0'
  try {
    const config = JSON.parse(await redis.get(`unoapi-config:${phone}`) || 'null')
    if (!config || config.provider !== 'zapo') throw new Error('source_missing')
    await line({ kind: 'meta', phone, prefix, sampledAt: Date.now(), liveReadNotAtomicSnapshot: true,
      config: { provider: 'zapo', name: `Storage fixture ${phone}`, connectionType: config.connectionType || 'qrcode', zapoWebClientProfile: config.zapoWebClientProfile || 'default', primary: !!config.mobilePrimaryDraftId } })
    do {
      const page = await redis.scan(cursor, 'COUNT', 1000); cursor = page[0]
      const selected = page[1].filter(own)
      for (let offset = 0; offset < selected.length; offset += 100) {
        const keys = selected.slice(offset, offset + 100), pipe = redis.pipeline()
        keys.forEach(key => pipe.dumpBuffer(key).pttl(key).call('MEMORY', 'USAGE', key, 'SAMPLES', 5))
        const capturedAt = Date.now(), values = await pipe.exec()
        for (let i = 0; i < keys.length; i++) {
          const dump = values[i * 3][1], ttl = Number(values[i * 3 + 1][1]), memory = values[i * 3 + 2][1]
          if (!Buffer.isBuffer(dump) || ttl === -2 || ttl === 0) continue
          count++; bytes += dump.length; memoryBytes += Number(memory) || 0
          if (count > 1000000 || bytes > 2 * 1024 ** 3) throw new Error('export_limit')
          await line({ kind: 'record', key: keys[i], dump: dump.toString('base64'), expiresAt: ttl >= 0 ? capturedAt + ttl : null })
        }
      }
      await new Promise(resolve => setTimeout(resolve, 15))
    } while (cursor !== '0')
    await line({ kind: 'complete', count, dumpBytes: bytes, estimatedRedisMemoryBytes: memoryBytes }); completed = true; res.end()
    console.log(JSON.stringify({ event: 'fixture_export_completed', phone, count, dumpBytes: bytes, estimatedRedisMemoryBytes: memoryBytes, redisWrites: 0 }))
  } catch { res.destroy(); console.log('fixture_export_failed_no_payload_logged') }
  finally { active = false }
})
server.listen(Number(process.env.STORAGE_FIXTURE_PORT || 35571), '0.0.0.0', () => console.log('fixture_exporter_ready'))
const stop = () => { server.close(); redis.disconnect(); process.exit(0) }
setTimeout(stop, 20 * 60 * 1000).unref()
process.on('SIGINT', stop); process.on('SIGTERM', stop)
