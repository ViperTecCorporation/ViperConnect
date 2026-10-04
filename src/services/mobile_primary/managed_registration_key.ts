import { createHash, randomBytes } from 'node:crypto'
import { RegistrationVault } from './registration_vault'

// Deliberately outside RedisAdmin's allowed prefixes and session backup records.
export const MANAGED_REGISTRATION_KEY = 'mobile-primary:{v1}:vault-key'
export const MANAGED_REGISTRATION_MARKER = 'mobile-primary:{v1}:vault-key-fingerprint'
const registrationPrefix = 'mobile-primary:{v1}:registration:'
const valid = (value: string) => /^[a-f0-9]{64}$/i.test(value)
const fingerprint = (key: string) => createHash('sha256').update(key.toLowerCase()).digest('hex')

export interface ManagedKeyRedis {
  get(key: string): Promise<string | null>
  mGet(keys: string[]): Promise<(string | null)[]>
  scan(cursor: string, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number | string; keys: string[] }>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export const INSTALL_REGISTRATION_KEY = `
local current = redis.call('GET', KEYS[1])
if current then return current end
local marker = redis.call('GET', KEYS[2])
if marker and marker ~= ARGV[2] then return '' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return ARGV[1]`

class ManagedKeyError extends Error {}
const fail = (reason: string): never => { throw new ManagedKeyError(`mobile_registration_key_${reason}`) }

/** One persistent secret per Redis database, independent of server name/API token.
 * Redis access and full Redis backups must be protected: they contain the key.
 * Environment input is only a compatibility path for existing installations. */
export async function ensureManagedRegistrationKey(redis: ManagedKeyRedis, legacyKey = ''): Promise<string> {
  try {
    if (legacyKey && !valid(legacyKey)) fail('invalid_legacy')
    // Atomic snapshot: separate GETs could mistake a concurrent initialization
    // between reads for a lost key.
    const [current, marker] = await redis.mGet([MANAGED_REGISTRATION_KEY, MANAGED_REGISTRATION_MARKER])
    if (current !== null) {
      if (!valid(current) || marker !== fingerprint(current)) fail('state_invalid')
      if (legacyKey && legacyKey.toLowerCase() !== current.toLowerCase()) fail('legacy_mismatch')
      return current
    }
    if (marker && (!legacyKey || fingerprint(legacyKey) !== marker)) fail('missing_restore_required')

    // Never create an unrelated key over credentials encrypted by an old build.
    // Legacy migration verifies every registration before adopting its key.
    for (const prefix of [registrationPrefix, 'mobile-primary:{v1}:companions:']) {
      let cursor = '0'
      do {
        const page = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 })
        cursor = String(page.cursor)
        for (const key of page.keys) {
          const encrypted = await redis.get(key)
          if (encrypted === null) continue
          if (!legacyKey) fail('legacy_required')
          const id = prefix === registrationPrefix ? key.slice(prefix.length) : key
          try { new RegistrationVault(legacyKey).open(id, encrypted) }
          catch { fail('legacy_mismatch') }
        }
      } while (cursor !== '0')
    }

    const candidate = legacyKey.toLowerCase() || randomBytes(32).toString('hex')
    const installed = await redis.eval(INSTALL_REGISTRATION_KEY, {
      keys: [MANAGED_REGISTRATION_KEY, MANAGED_REGISTRATION_MARKER],
      arguments: [candidate, fingerprint(candidate)],
    })
    if (typeof installed !== 'string' || !valid(installed)) fail('state_invalid')
    if (legacyKey && installed !== legacyKey.toLowerCase()) fail('legacy_mismatch')
    return installed as string
  } catch (error) {
    // Redis command exceptions may include command arguments. Do not leak them.
    if (error instanceof ManagedKeyError) throw error
    throw new ManagedKeyError('mobile_registration_key_storage_unavailable')
  }
}

export async function initializeManagedRegistrationKey(): Promise<void> {
  const { getRedis } = await import('../redis.js')
  const key = await ensureManagedRegistrationKey(await getRedis(), process.env.MOBILE_REGISTRATION_KEY || '')
  // Internal process state only; never exported through Docker, HTTP or logs.
  process.env.MOBILE_REGISTRATION_KEY = key
}
