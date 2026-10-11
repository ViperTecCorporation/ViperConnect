'use strict'
// Explicit one-session operational repair. Default is read-only inventory.
// RENAME preserves values and TTLs; originals are never deleted or overwritten.
const Redis = require('ioredis')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { isMobileBackupKey } = require(path.join(process.cwd(), 'dist/src/services/mobile_primary/backup_manifest.js'))
const phone = process.argv[2]
if (!/^[1-9]\d{7,14}$/.test(phone || '')) throw Error('invalid_phone')
const apply = process.argv.includes('--apply')
const prefix = process.env.ZAPO_REDIS_KEY_PREFIX || 'unoapi:zapo:'
const r = new Redis(process.env.REDIS_URL)
const lease = `unoapi-lease:zapo-session:${phone}`, token = randomUUID()
const quarantine = `restore-quarantine:${token}:`, journal = quarantine + 'journal'
async function inventory() {
  const keys = new Set(), counts = {}
  let cursor = '0'
  do {
    const page = await r.scan(cursor, 'MATCH', '*' + phone + '*', 'COUNT', 1000)
    cursor = page[0]
    for (const key of page[1]) {
      const base = key.startsWith(prefix) ? prefix : key.startsWith('unoapi-') ? 'unoapi-' : null
      if (!base || !isMobileBackupKey(key.slice(base.length), phone, 'complete', base === 'unoapi-' ? 'uno' : undefined) || keys.has(key)) continue
      keys.add(key)
      const domain = key.slice(base.length).split(':' + phone)[0]
      counts[(base === 'unoapi-' ? 'uno:' : 'zapo:') + domain] = (counts[(base === 'unoapi-' ? 'uno:' : 'zapo:') + domain] || 0) + 1
    }
  } while (cursor !== '0')
  return { keys: [...keys], counts }
}
async function guard() {
  if (await r.exists('unoapi-config:' + phone) || await r.hexists('mobile-primary:{v1}:drafts', phone)) throw Error('destination_has_live_registration')
}
async function main() {
  await guard()
  const before = await inventory()
  console.log(JSON.stringify({ phone, apply, count: before.keys.length, domains: before.counts }))
  if (!apply) return
  if (await r.set(lease, token, 'PX', 120000, 'NX') !== 'OK') throw Error('session_owned_or_busy')
  try {
    await guard()
    const script = `
      if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('EXISTS',KEYS[2])~=0 or redis.call('HEXISTS',KEYS[3],ARGV[2])==1 then return -1 end
      for i=5,#KEYS,2 do if redis.call('EXISTS',KEYS[i+1])~=0 then return -2 end end
      redis.call('PEXPIRE',KEYS[1],120000)
      local n=0
      for i=5,#KEYS,2 do
        if redis.call('EXISTS',KEYS[i])==1 then
          redis.call('RPUSH',KEYS[4],cjson.encode({source=KEYS[i],target=KEYS[i+1]}))
          redis.call('RENAME',KEYS[i],KEYS[i+1]); n=n+1
        end
      end
      return n`
    let moved = 0
    for (let offset = 0; offset < before.keys.length; offset += 100) {
      const keys = [lease, 'unoapi-config:' + phone, 'mobile-primary:{v1}:drafts', journal, ...before.keys.slice(offset, offset + 100).flatMap(key => [key, quarantine + key])]
      const result = Number(await r.eval(script, keys.length, ...keys, token, phone))
      if (result < 0) throw Error('quarantine_fenced_or_collision')
      moved += result
    }
    const after = await inventory()
    console.log(JSON.stringify({ phone, moved, remaining: after.keys.length, journal, quarantine, ttlPreserved: true }))
    if (after.keys.length) throw Error('new_data_detected_review_before_restore')
  } finally {
    await r.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lease, token)
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => r.quit())
