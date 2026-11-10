/* Temporary diagnostic: read-only staging and source, aggregate output only. */
process.env.UNO_LOG_LEVEL = 'silent'
const { DatabaseSync } = require('node:sqlite')
const Redis = require('ioredis')
const path = process.env.STORAGE_STAGING_PATH
if (process.env.UNOAPI_SERVER_NAME !== 'mobile_lab' || process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY !== 'true' || !/^\/app\/session-data\/session-storage\/[a-f0-9-]{36}\/migration-[a-f0-9-]{36}\.sqlite$/.test(path || '')) throw new Error('diagnostic_scope_invalid')
const db = new DatabaseSync(path, { readOnly: true }), row = (sql, args = []) => db.prepare(sql).get(...args)
const prefix = !process.env.ZAPO_REDIS_KEY_PREFIX || process.env.ZAPO_REDIS_KEY_PREFIX === 'unoapi-zapo:' ? 'unoapi:zapo:' : process.env.ZAPO_REDIS_KEY_PREFIX
const first = row('SELECT key FROM uno_redis_types WHERE key>=? AND key<? ORDER BY key LIMIT 1', [prefix, prefix + '\uffff'])
const phone = first?.key.slice(prefix.length).split(':').find(value => /^\d{8,16}$/.test(value))
if (!phone) throw new Error('diagnostic_identity_missing')
const relative = key => key.slice(prefix.length).replace(phone, '[session]').replace(/:[^:]+/g, value => /^(?:\[session\]|msg|idx|key|col|set|auth|signal|reg|spk|sess|pk|priv|pub|message_bytes|contact|thread|plaintext|meta)$/.test(value.slice(1)) ? value : ':*')
const family = key => key.slice(prefix.length).split(':' + phone)[0]
const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 15000 }); redis.on('error', () => {})
async function main() {
  await redis.connect()
  const now = Date.now(), report = { readOnly: true, stagingRows: Number(row('SELECT COUNT(*) n FROM uno_redis_types').n), nativeRows: Number(row('SELECT COUNT(*) n FROM uno_redis_types WHERE key>=? AND key<?', [prefix, prefix + '\uffff']).n), tables: {}, boundary: [] }
  for (const name of ['auth_credentials', 'mailbox_messages', 'mailbox_contacts', 'mailbox_threads', 'appstate_collection_index_values', 'appstate_sync_keys', 'signal_prekey', 'signal_session', 'signal_identity', 'sender_keys', 'uno_native_expiry']) report.tables[name] = Number(row(`SELECT COUNT(*) n FROM ${name}`).n)
  const range = db.prepare('SELECT key,type,expires_at FROM uno_redis_types WHERE key>=? AND key<? ORDER BY key LIMIT 130 OFFSET 81180').all(prefix, prefix + '\uffff')
  for (const [index, entry] of range.entries()) {
    const key = entry.key, native = family(key), info = { ordinal: 81181 + index, family: native, type: entry.type, expiredAtInspection: entry.expires_at !== null && entry.expires_at <= now, sourceExists: await redis.exists(key), destinationExists: null, rawFields: null }
    if (native === 'msg' && entry.type === 'hash') {
      const id = key.slice(`${prefix}msg:${phone}:`.length)
      info.destinationExists = !!row('SELECT 1 found FROM mailbox_messages WHERE session_id=? AND message_id=?', [phone, id])
      const fields = db.prepare('SELECT field FROM uno_hash WHERE key=?').all(key).map(field => field.field)
      info.rawFields = { id: fields.includes('id'), thread: fields.includes('thread_jid'), timestamp: fields.includes('timestamp_ms'), fromMe: fields.includes('from_me') }
      const raw = row('SELECT value,expires_at FROM uno_kv WHERE key=?', [key + ':message_bytes'])
      info.rawBinary = { present: !!raw, expired: !!raw && raw.expires_at !== null && raw.expires_at <= now }
    }
    report.boundary.push(info)
  }
  const lastExpiry = row('SELECT domain,COUNT(*) n FROM uno_native_expiry GROUP BY domain ORDER BY domain DESC LIMIT 1'); report.lastExpiryDomain = lastExpiry?.domain
  report.integrity = row('PRAGMA quick_check').quick_check
  console.log(JSON.stringify(report))
}
main().catch(error => { console.log(JSON.stringify({ diagnosticFailed: true, code: /^[a-z_]+$/.test(error.message || '') ? error.message : 'read_failed' })) }).finally(async () => { db.close(); await redis.quit() })
