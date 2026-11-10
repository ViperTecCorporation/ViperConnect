#!/usr/bin/env node
'use strict'

// This CLI restores only an absent session offline. It never starts the app,
// invokes WhatsApp, replays queues, activates an RDB or prints credentials.
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const value = { confirm: true, confirmOriginOffline: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (!['--phone', '--backup-id', '--weekday', '--confirm-offline'].includes(name) || seen.has(name)) throw new Error('session_storage_standalone_arguments_invalid')
    seen.add(name)
    if (name === '--confirm-offline') { value.confirmOriginOffline = true; continue }
    const input = args[++i]
    if (!input || input.startsWith('--')) throw new Error('session_storage_standalone_arguments_invalid')
    if (name === '--phone') value.phone = input
    else if (name === '--backup-id') value.backupId = input
    else { if (!/^[0-6]$/.test(input)) throw new Error('session_storage_backup_slot_invalid'); value.weekday = Number(input) }
  }
  if (!/^[1-9]\d{7,14}$/.test(value.phone || '') || !value.confirmOriginOffline || (value.backupId === undefined) === (value.weekday === undefined)
    || value.backupId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.backupId)) throw new Error('session_storage_standalone_arguments_invalid')
  return value
}

async function main(args = process.argv.slice(2)) {
  const input = parseArgs(args)
  if (input.help) {
    process.stdout.write('Usage: node scripts/restore-session-from-s3.cjs --phone DIGITS (--backup-id UUID | --weekday 0..6) --confirm-offline\n')
    process.stdout.write('Uses configured REDIS_URL, STORAGE_*, UNOAPI_SERVER_NAME, SESSION_STORAGE_ROOT/PERSISTENT; SESSION_STORAGE_BACKUP_KEY_FILE is optional for legacy encrypted archives only. Mobile Primary also requires MOBILE_REGISTRATION_KEY. Origin must be offline. Target session/identity must be absent. No connect or replay.\n')
    return
  }
  require('dotenv').config({ quiet: true })
  process.env.UNO_LOG_LEVEL = 'silent'
  const path = require('node:path'), { randomUUID } = require('node:crypto')
  const { createClient } = require('@redis/client')
  const base = path.join(__dirname, '../dist/src/services/session_storage')
  const { restoreStandaloneSession } = require(path.join(base, 'standalone_recovery.js'))
  const { createBackupObjects } = require(path.join(base, 'backup_objects.js'))
  const { requireStorageVolume, storageWorkerIdentity } = require(path.join(base, 'capability.js'))
  const { isSessionSourceCleanupKey } = require(path.join(base, 'source_cleanup.js'))
  const { sessionBackupPassword } = require(path.join(base, 'backup_runtime.js'))
  if (!process.env.REDIS_URL || !process.env.STORAGE_ENDPOINT || !process.env.STORAGE_BUCKET_NAME || !storageWorkerIdentity().valid) throw new Error('session_storage_standalone_configuration_invalid')
  const baseStore = requireStorageVolume(), password = sessionBackupPassword()
  const redis = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 5000, reconnectStrategy: false } })
  redis.on('error', () => {})
  try {
    await redis.connect()
    const rawPrefix = process.env.ZAPO_REDIS_KEY_PREFIX || 'unoapi:zapo:', prefix = rawPrefix === 'unoapi-zapo:' ? 'unoapi:zapo:' : rawPrefix
    const result = await restoreStandaloneSession(input, {
      objects: createBackupObjects(), redis, baseStore, owner: storageWorkerIdentity().worker, password, registrationKey: process.env.MOBILE_REGISTRATION_KEY,
      lease: phone => {
        const key = `unoapi-lease:zapo-session:${phone}`, token = randomUUID()
        return {
          ownership: () => ({ key, token }),
          acquire: async () => Number(await redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',120000); return 1", { keys: [key], arguments: [token] })) === 1,
          assertOwned: async () => { if (Number(await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],120000); return 1", { keys: [key], arguments: [token] })) !== 1) throw new Error('session_storage_lease_lost') },
          release: () => redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [key], arguments: [token] }),
        }
      },
      destinationEmpty: async (phone, ownedKeys) => {
        let cursor = '0', inspected = 0
        do {
          const page = await redis.scan(cursor, { MATCH: `*${phone}*`, COUNT: 100 }); cursor = String(page.cursor)
          for (const key of page.keys) {
            if (++inspected > 10000) throw new Error('session_storage_standalone_destination_scan_limit')
            if (!ownedKeys.includes(key) && (key === `unoapi-config:${phone}` || key === `unoapi-status:${phone}` || isSessionSourceCleanupKey(key, phone, prefix))) return false
          }
        } while (cursor !== '0')
        return true
      },
    })
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally { if (redis.isOpen) await redis.quit() }
}

if (require.main === module) main().catch(error => {
  const code = typeof error.code === 'string' && /^session_storage_[a-z_]+$/.test(error.code) ? error.code
    : typeof error.message === 'string' && /^session_storage_[a-z_]+$/.test(error.message) ? error.message : 'session_storage_standalone_restore_failed'
  process.stderr.write(JSON.stringify({ restored: false, code, ...(error.recovery ? { recovery: error.recovery } : {}), connected: false, replayed: false }) + '\n')
  process.exitCode = 1
})
module.exports = { parseArgs, main }
