import { createHash } from 'node:crypto'
import { ensureManagedRegistrationKey, MANAGED_REGISTRATION_KEY as KEY, MANAGED_REGISTRATION_MARKER as MARKER, type ManagedKeyRedis } from '../../src/services/mobile_primary/managed_registration_key'
import { RegistrationVault } from '../../src/services/mobile_primary/registration_vault'
import { isAllowedRedisKey } from '../../src/services/redis_admin'

function fixture() {
  const values = new Map<string, string>()
  const redis: ManagedKeyRedis = {
    get: async key => values.get(key) ?? null,
    mGet: async keys => keys.map(key => values.get(key) ?? null),
    scan: async (_cursor, options) => ({ cursor: 0, keys: [...values.keys()].filter(key => key.startsWith(options.MATCH.slice(0, -1))) }),
    eval: async (_script, { keys, arguments: args }) => {
      if (values.has(keys[0])) return values.get(keys[0])
      if (values.has(keys[1]) && values.get(keys[1]) !== args[1]) return ''
      values.set(keys[0], args[0]); values.set(keys[1], args[1]); return args[0]
    },
  }
  return { redis, values }
}

test('concurrent web/workers share one persistent key without ENV or API token', async () => {
  const { redis, values } = fixture()
  const results = await Promise.all(Array.from({ length: 12 }, () => ensureManagedRegistrationKey(redis)))
  expect(new Set(results).size).toBe(1)
  expect(results[0]).toMatch(/^[a-f0-9]{64}$/)
  expect(values.size).toBe(2)
  expect(await ensureManagedRegistrationKey(redis)).toBe(results[0])
})
test('existing encryption key migrates without reencrypting credentials', async () => {
  const { redis, values } = fixture(), key = 'ab'.repeat(32)
  const encrypted = new RegistrationVault(key).seal('device', { registered: true })
  values.set('mobile-primary:{v1}:registration:device', encrypted)
  expect(await ensureManagedRegistrationKey(redis, key)).toBe(key)
  expect(await ensureManagedRegistrationKey(redis)).toBe(key)
  expect(values.get('mobile-primary:{v1}:registration:device')).toBe(encrypted)
})
test.each(['', 'cd'.repeat(32)])('refuses absent or incorrect legacy key', async legacy => {
  const { redis, values } = fixture()
  values.set('mobile-primary:{v1}:registration:device', new RegistrationVault('ab'.repeat(32)).seal('device', {}))
  await expect(ensureManagedRegistrationKey(redis, legacy)).rejects.toThrow(/legacy_(required|mismatch)/)
  expect(values.has(KEY)).toBe(false)
})
test('lost key is not silently regenerated, even after registrations were removed', async () => {
  const { redis, values } = fixture()
  const original = await ensureManagedRegistrationKey(redis)
  values.delete(KEY)
  await expect(ensureManagedRegistrationKey(redis)).rejects.toThrow('missing_restore_required')
  expect(await ensureManagedRegistrationKey(redis, original)).toBe(original)
})
test('different legacy configuration never overwrites managed key', async () => {
  const { redis, values } = fixture()
  const original = await ensureManagedRegistrationKey(redis, 'ab'.repeat(32))
  await expect(ensureManagedRegistrationKey(redis, 'cd'.repeat(32))).rejects.toThrow('legacy_mismatch')
  expect(values.get(KEY)).toBe(original)
})
test('orphaned companion credentials also prevent unrelated key generation', async () => {
  const { redis, values } = fixture(), key = 'ab'.repeat(32), id = 'mobile-primary:{v1}:companions:device'
  values.set(id, new RegistrationVault(key).seal(id, { identity: 'retained' }))
  await expect(ensureManagedRegistrationKey(redis)).rejects.toThrow('legacy_required')
  expect(await ensureManagedRegistrationKey(redis, key)).toBe(key)
})
test('invalid state and invalid ENV fail closed', async () => {
  const { redis, values } = fixture()
  await expect(ensureManagedRegistrationKey(redis, 'short')).rejects.toThrow('invalid_legacy')
  values.set(KEY, 'not-a-key')
  await expect(ensureManagedRegistrationKey(redis)).rejects.toThrow('state_invalid')
  values.set(KEY, 'ab'.repeat(32)); values.set(MARKER, createHash('sha256').update('different').digest('hex'))
  await expect(ensureManagedRegistrationKey(redis)).rejects.toThrow('state_invalid')
})
test('storage errors never expose Redis command arguments', async () => {
  const { redis } = fixture()
  redis.eval = async () => { throw new Error('secret-command-arguments') }
  await expect(ensureManagedRegistrationKey(redis)).rejects.toThrow('mobile_registration_key_storage_unavailable')
})
test('managed material is excluded from the administrative Redis browser', () => {
  expect(isAllowedRedisKey(KEY)).toBe(false)
  expect(isAllowedRedisKey(MARKER)).toBe(false)
})
