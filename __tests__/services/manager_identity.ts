import { ManagerError, ManagerIdentity, ManagerRedis } from '../../src/services/manager_identity'
import { createClient } from '@redis/client'
import { randomUUID } from 'crypto'

// A stateful Redis contract double, not an unconditional EVAL success stub.
// Scripts' branch conditions, atomic mutations, expiry and audit trimming are modelled.
// This does not replace running the Lua text on a real Redis server.
class MemoryRedis implements ManagerRedis {
  strings = new Map<string, string>()
  hashes = new Map<string, Record<string, string>>()
  lists = new Map<string, string[]>()
  expires = new Map<string, number>()
  now = Date.now()
  hash(key: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, Object.create(null))
    return this.hashes.get(key)!
  }
  expire(key: string) {
    if ((this.expires.get(key) ?? Infinity) <= this.now) { this.strings.delete(key); this.expires.delete(key) }
  }
  async get(key: string) { this.expire(key); return this.strings.get(key) ?? null }
  async set(key: string, value: string, options: { EX: number }) { this.strings.set(key, value); this.expires.set(key, this.now + options.EX * 1000); return 'OK' }
  async del(key: string) { this.expires.delete(key); return this.strings.delete(key) }
  async hGet(key: string, field: string) { return this.hash(key)[field] }
  async hGetAll(key: string) { return { ...this.hash(key) } }
  async lRange(key: string, start: number, end: number) { return (this.lists.get(key) || []).slice(start, end + 1) }
  async eval(script: string, { keys: k, arguments: a }: { keys: string[]; arguments: string[] }) {
    // No awaits inside mutations: Redis executes each Lua invocation atomically.
    if (script.includes("redis.call('INCR'")) {
      let allowed = true
      for (const key of k) {
        this.expire(key)
        const count = Number(this.strings.get(key) || 0) + 1
        this.strings.set(key, String(count))
        if (count === 1) this.expires.set(key, this.now + 900000)
        if (count > 10) allowed = false
      }
      return allowed ? 1 : 0
    }
    if (script.includes("redis.call('HEXISTS'")) {
      if (this.hash(k[0])[a[0]]) return 0
      this.hash(k[0])[a[0]] = a[1]
      this.hash(k[1])[a[1]] = a[2]
      return 1
    }
    if (script.includes('current_owner')) {
      const current = this.hash(k[0])[a[0]] || ''
      if (current !== a[1]) return JSON.stringify({ conflict: true, current_owner: current })
      if (a[2]) {
        const raw = this.hash(k[2])[a[2]]
        if (!raw || !JSON.parse(raw).active) return JSON.stringify({ invalid: true })
      }
      if (current !== a[2]) {
        if (a[2]) this.hash(k[0])[a[0]] = a[2]
        else delete this.hash(k[0])[a[0]]
        this.lists.set(k[1], [a[3], ...(this.lists.get(k[1]) || [])].slice(0, 10000))
      }
      return JSON.stringify({ ok: true })
    }
    if (script.includes("redis.call('HGETALL'")) {
      for (const [id, raw] of Object.entries(this.hash(k[0]))) {
        const key = JSON.parse(raw)
        if (key.userId === a[0] && (!a[1] || key.id === a[1])) {
          this.hash(k[0])[id] = JSON.stringify({ ...key, revoked: true })
          delete this.hash(k[1])[key.digest]
        }
      }
      return 1
    }
    if (script.includes('key.last_used_at =')) {
      const raw = this.hash(k[0])[a[0]]
      if (!raw) return 0
      const key = JSON.parse(raw)
      if (key.revoked || key.digest !== a[1]) return 0
      this.hash(k[0])[a[0]] = JSON.stringify({ ...key, last_used_at: a[2] })
      return 1
    }
    if (script.includes('local user =')) {
      const raw = this.hash(k[2])[a[0]]
      if (!raw || !JSON.parse(raw).active) return 0
      this.hash(k[0])[a[1]] = a[2]
      this.hash(k[1])[a[3]] = a[1]
      return 1
    }
    if (script.includes('~= ARGV[2]')) {
      if (this.hash(k[0])[a[0]] !== a[1]) return 0
      this.hash(k[0])[a[0]] = a[2]
      return 1
    }
    throw new Error('Unmodelled Lua script')
  }
}

describe('ManagerIdentity', () => {
  let redis: MemoryRedis
  let service: ManagerIdentity
  const stack = 'test-only-stack-token'
  const create = (username = 'alice') => service.createUser({ username, name: username, password: 'password-123' })
  const login = (username = 'alice', ip = '127.0.0.1') => service.login(username, 'password-123', ip)
  beforeEach(() => { redis = new MemoryRedis(); service = new ManagerIdentity(async () => redis, stack) })

  test('atomically enforces case-insensitive uniqueness and reserves admin', async () => {
    const results = await Promise.allSettled([create('Alice'), create('ALICE')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(await service.users()).toHaveLength(1)
    await expect(create('ADMIN')).rejects.toMatchObject({ status: 400 })
  })

  test('uses salted scrypt, returns only public fields, and stores no raw credential', async () => {
    const user = await create()
    await create('bob')
    const result = await login('ALICE')
    const key = await service.createKey(user.id, { name: 'automation' })
    expect(result.token).toMatch(/^mgr_login_[a-f0-9]{64}$/)
    expect(key.token).toMatch(/^mgr_key_[a-f0-9]{64}$/)
    const serialized = JSON.stringify([Array.from(redis.strings), Array.from(redis.hashes)])
    expect(serialized).not.toContain('password-123')
    expect(serialized).not.toContain(result.token)
    expect(serialized).not.toContain(key.token)
    const users = Object.values(redis.hashes.get('manager-identity:{v1}:users')!).map(raw => JSON.parse(raw))
    expect(users[0].password).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)
    expect(users[0].password).not.toEqual(users[1].password)
    const publicData = JSON.stringify([user, result.user, await service.users(), await service.keys(user.id), await service.authenticate(key.token)])
    expect(publicData).not.toMatch(/password|generation|digest/)
    expect(publicData).not.toContain(users[0].password)
    expect([...redis.expires.values()]).toContain(redis.now + 43200000)
  })

  test('admin supports stack and login, never returns stack secret, rejects wrong/empty secret', async () => {
    expect(await service.authenticate(stack)).toMatchObject({ id: 'admin', role: 'admin', kind: 'stack' })
    const result = await service.login('ADMIN', stack, '::1')
    expect(result.token).not.toBe(stack)
    expect(JSON.stringify(result)).not.toContain(stack)
    expect(await service.authenticate(result.token)).toMatchObject({ kind: 'login', role: 'admin' })
    await expect(service.login('admin', 'bad', '::1')).rejects.toMatchObject({ status: 401 })
    const noAdmin = new ManagerIdentity(async () => redis, '')
    expect(await noAdmin.authenticate(stack)).toBeUndefined()
    await expect(noAdmin.login('admin', '', '::1')).rejects.toMatchObject({ status: 401 })
    expect(await new ManagerIdentity(async () => redis, 'rotated').authenticate(result.token)).toBeUndefined()
  })

  test('rate limits username and IP independently to ten attempts for fifteen minutes', async () => {
    for (let i = 0; i < 10; i++) await expect(service.login('admin', 'wrong', `ip-${i}`)).rejects.toMatchObject({ status: 401 })
    await expect(service.login('ADMIN', stack, 'fresh-ip')).rejects.toMatchObject({ status: 429 })
    redis.now += 900001
    await expect(service.login('admin', stack, 'fresh-ip')).resolves.toHaveProperty('token')
    for (let i = 0; i < 10; i++) await expect(service.login(`unknown-${i}`, 'wrong', 'shared-ip')).rejects.toMatchObject({ status: 401 })
    await expect(service.login('admin', stack, 'shared-ip')).rejects.toMatchObject({ status: 429 })
  })

  test('fresh assignments, CAS conflict, unassignment and durable history', async () => {
    const a = await create()
    const b = await create('bob')
    const { token } = await login()
    const api = await service.createKey(a.id, { name: 'key' })
    await service.assign('+5511999999999', a.id, null, 'admin')
    expect(await service.owner('5511999999999')).toBe(a.id)
    expect((await service.authenticate(token))?.phones).toEqual(['5511999999999'])
    expect((await service.authenticate(api.token))?.phones).toEqual(['5511999999999'])
    const results = await Promise.allSettled([
      service.assign('5511999999999', b.id, a.id, 'admin'),
      service.assign('5511999999999', null, a.id, 'admin'),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, details: { current_owner: b.id } } })
    expect((await service.authenticate(token))?.phones).toEqual([])
    expect((await service.authenticate(api.token))?.phones).toEqual([])
    await service.assign('5511999999999', null, b.id, 'admin')
    expect(await service.owner('5511999999999')).toBeNull()
    const history = (await service.assignments()).history
    expect(history).toHaveLength(3)
    expect(history[0]).toMatchObject({ phone: '5511999999999', from: b.id, to: null, actor: 'admin' })
    expect(Number.isFinite(Date.parse(history[0].at))).toBe(true)
    await service.logout(token)
    expect(await service.users()).toHaveLength(2)
    expect((await new ManagerIdentity(async () => redis).assignments()).history).toEqual(history)
  })

  test('history is bounded to 10000 and no-op assignments do not append', async () => {
    const user = await create()
    redis.lists.set('manager-identity:{v1}:history', Array(10000).fill(JSON.stringify({ phone: '5511111111111' })))
    await service.assign('5511999999999', user.id, null, 'admin')
    await service.assign('5511999999999', user.id, user.id, 'admin')
    expect((await service.assignments()).history).toHaveLength(10000)
    await expect(service.assign('5511888888888', 'missing', null, 'admin')).rejects.toMatchObject({ status: 400 })
  })

  test.each(['abc5511999999999', '1234567', '1'.repeat(16), '++5511999999999', '55 11999999999', '5511999999999@s.whatsapp.net'])('rejects arbitrary phone %s', async phone => {
    await expect(service.owner(phone)).rejects.toMatchObject({ status: 400 })
    await expect(service.assign(phone, null, null, 'admin')).rejects.toMatchObject({ status: 400 })
  })

  test('password resets revoke every login while preserving API keys; inactive denies both', async () => {
    const user = await create()
    const first = await login()
    const second = await login()
    const key = await service.createKey(user.id, { name: 'integration' })
    await service.updateUser(user.id, { password: 'replacement-password', name: 'Alice Updated' })
    expect(await service.authenticate(first.token)).toBeUndefined()
    expect(await service.authenticate(second.token)).toBeUndefined()
    expect(await service.authenticate(key.token)).toMatchObject({ name: 'Alice Updated', kind: 'api' })
    await expect(login()).rejects.toMatchObject({ status: 401 })
    const fresh = await service.login('alice', 'replacement-password', 'ip-new')
    await service.updateUser(user.id, { active: false })
    expect(await service.authenticate(fresh.token)).toBeUndefined()
    expect(await service.authenticate(key.token)).toBeUndefined()
    await expect(service.login('alice', 'replacement-password', 'ip-new')).rejects.toMatchObject({ status: 401 })
    await expect(service.createKey(user.id, { name: 'nope' })).rejects.toMatchObject({ status: 400 })
    await expect(service.assign('5511999999999', user.id, null, 'admin')).rejects.toMatchObject({ status: 400 })
  })

  test('changePassword verifies current password, revokes login and leaves keys', async () => {
    const user = await create()
    const session = await login()
    const key = await service.createKey(user.id, { name: 'api' })
    await expect(service.changePassword(user.id, 'wrong', 'new-password')).rejects.toMatchObject({ status: 401 })
    await service.changePassword(user.id, 'password-123', 'new-password')
    expect(await service.authenticate(session.token)).toBeUndefined()
    expect(await service.authenticate(key.token)).toBeDefined()
    await expect(service.login('alice', 'new-password', 'ip')).resolves.toHaveProperty('token')
  })

  test('login expiry, logout, key expiry, scoped revocation and revoke all', async () => {
    const user = await create()
    const other = await create('bob')
    const session = await login()
    redis.now += 43200001
    expect(await service.authenticate(session.token)).toBeUndefined()
    const fresh = await login()
    await service.logout(fresh.token)
    expect(await service.authenticate(fresh.token)).toBeUndefined()
    const first = await service.createKey(user.id, { name: 'first' })
    const second = await service.createKey(user.id, { name: 'second', days: 1 })
    expect(Date.parse(first.key.expiresAt) - Date.parse(first.key.createdAt)).toBeCloseTo(90 * 86400000, -2)
    await service.revokeKey(other.id, first.key.id)
    expect(await service.authenticate(first.token)).toBeDefined()
    await service.revokeKey(user.id, first.key.id)
    expect(await service.authenticate(first.token)).toBeUndefined()
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(second.key.expiresAt))
    try { expect(await service.authenticate(second.token)).toBeUndefined() } finally { now.mockRestore() }
    await service.revokeKeys(user.id)
    expect(await service.keys(user.id)).toHaveLength(2)
    expect((await service.keys(user.id)).every(key => key.revoked)).toBe(true)
    expect(await service.authenticate(second.token)).toBeUndefined()
  })

  test('validates lengths, boolean, validity and missing users', async () => {
    const user = await create()
    await expect(create('a'.repeat(65))).rejects.toMatchObject({ status: 400 })
    await expect(service.createUser({ username: 'short', name: 'ok', password: 'short' })).rejects.toMatchObject({ status: 400 })
    await expect(service.updateUser(user.id, { active: 'false' as unknown as boolean })).rejects.toMatchObject({ status: 400 })
    await expect(service.updateUser(user.id, { name: 'x'.repeat(129) })).rejects.toMatchObject({ status: 400 })
    for (const days of [NaN, Infinity, -1, 0, 366, null, '90']) await expect(service.createKey(user.id, { name: 'key', days: days as number })).rejects.toMatchObject({ status: 400 })
    await expect(service.keys('missing')).rejects.toMatchObject({ status: 404 })
    await expect(service.updateUser('missing', { name: 'ok' })).rejects.toMatchObject({ status: 404 })
    expect(await service.authenticate('nonsense')).toBeUndefined()
  })

  test('fails closed without leaking underlying errors, including stack admin', async () => {
    const failed = new ManagerIdentity(async () => { throw new Error('secret Redis URL') }, stack)
    for (const operation of [() => failed.authenticate(stack), () => failed.login('admin', stack, 'ip'), () => failed.users(), () => failed.assignments(), () => failed.owner('5511999999999')]) {
      await expect(operation()).rejects.toEqual(new ManagerError(503, 'Manager identity storage unavailable'))
    }
    jest.spyOn(redis, 'eval').mockRejectedValue(new Error('sensitive arguments'))
    await expect(service.login('admin', stack, 'ip')).rejects.toMatchObject({ status: 503 })
    await expect(create()).rejects.toMatchObject({ status: 503 })
  })

  test('concurrent profile update and password reset preserve both changes', async () => {
    const user = await create()
    await Promise.all([service.updateUser(user.id, { name: 'new name' }), service.updateUser(user.id, { password: 'new-password' })])
    expect((await service.login('alice', 'new-password', 'ip')).user.name).toBe('new name')
  })

  test('a stale password-change cannot overwrite a concurrent reset', async () => {
    const user = await create()
    const evalRedis = redis.eval.bind(redis)
    jest.spyOn(redis, 'eval').mockImplementation(async (script, options) => {
      if (script.includes('~= ARGV[2]')) {
        const stored = JSON.parse(redis.hash(options.keys[0])[user.id])
        stored.generation = 'concurrent-reset'
        redis.hash(options.keys[0])[user.id] = JSON.stringify(stored)
      }
      return evalRedis(script, options)
    })
    await expect(service.changePassword(user.id, 'password-123', 'next-password')).rejects.toMatchObject({ status: 409 })
    await expect(service.updateUser(user.id, { name: 'retry bounded' })).resolves.toMatchObject({ name: 'retry bounded' })
  })

  test('successful logins also consume the rate budget and logout does not revoke API keys', async () => {
    for (let i = 0; i < 10; i++) await service.login('admin', stack, 'same-ip')
    await expect(service.login('admin', stack, 'same-ip')).rejects.toMatchObject({ status: 429 })
    const user = await create()
    const key = await service.createKey(user.id, { name: 'api' })
    await service.logout(key.token)
    expect(await service.authenticate(key.token)).toMatchObject({ id: user.id, kind: 'api' })
  })

  test('frontend metadata includes prefix, snake timestamps, last use and durable revocation', async () => {
    const user = await create()
    const { token, key } = await service.createKey(user.id, { name: 'frontend' })
    expect(key).toMatchObject({ prefix: token.slice(0, 16), created_at: key.createdAt, expires_at: key.expiresAt, last_used_at: null, revoked: false })
    expect(key.prefix.length).toBeLessThan(token.length)
    await service.authenticate(token)
    const used = (await service.keys(user.id))[0]
    expect(Number.isFinite(Date.parse(used.last_used_at!))).toBe(true)
    await service.revokeKey(user.id, key.id)
    expect((await service.keys(user.id))[0]).toMatchObject({ revoked: true, last_used_at: used.last_used_at })
    expect(await service.authenticate(token)).toBeUndefined()
    expect(JSON.stringify(await service.keys(user.id))).not.toMatch(/digest/)
  })

  test('disabling permanently revokes login generations while API keys may resume', async () => {
    const user = await create()
    const session = await login()
    const key = await service.createKey(user.id, { name: 'resumable' })
    await service.updateUser(user.id, { active: false })
    expect(await service.authenticate(key.token)).toBeUndefined()
    await service.updateUser(user.id, { active: true })
    expect(await service.authenticate(session.token)).toBeUndefined()
    expect(await service.authenticate(key.token)).toBeDefined()
    expect(await service.authenticate((await login()).token)).toBeDefined()
  })

  test.each([null, undefined, [], 'string', 123, false])('invalid payload %p is a 400, not a storage failure', async input => {
    await expect(service.createUser(input as any)).rejects.toMatchObject({ status: 400, message: 'Invalid input' })
    await expect(service.updateUser('id', input as any)).rejects.toMatchObject({ status: 400, message: 'Invalid input' })
    await expect(service.createKey('id', input as any)).rejects.toMatchObject({ status: 400, message: 'Invalid input' })
  })

  test('admin key listing is empty but still fails closed on unavailable Redis', async () => {
    expect(await service.keys('admin')).toEqual([])
    jest.spyOn(redis, 'hGetAll').mockRejectedValue(new Error('offline'))
    await expect(service.keys('admin')).rejects.toMatchObject({ status: 503 })
  })
})

// Opt in with MANAGER_IDENTITY_TEST_REDIS_URL pointing at a disposable local Redis.
// Each run rewrites ONLY Redis keys into its own random namespace and deletes only
// those exact keys afterward. No FLUSHDB, production configuration or app Redis import.
const redisTestUrl = process.env.MANAGER_IDENTITY_TEST_REDIS_URL
if (redisTestUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisTestUrl).hostname)) {
  throw new Error('Manager Redis integration tests require an isolated local Redis, never production')
}
const redisIntegration = redisTestUrl ? describe : describe.skip
redisIntegration('ManagerIdentity real Redis Lua', () => {
  const client = createClient({ url: process.env.MANAGER_IDENTITY_TEST_REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 2000 } })
  const touched = new Set<string>()
  const namespace = `manager-identity-test:{${randomUUID()}}:`
  const mapKey = (key: string) => {
    const mapped = key.replace('manager-identity:{v1}:', namespace)
    if (!mapped.startsWith(namespace)) throw new Error('Unexpected test key')
    touched.add(mapped)
    return mapped
  }
  const adapter: ManagerRedis = {
    get: key => client.get(mapKey(key)),
    set: (key, value, options) => client.set(mapKey(key), value, options),
    del: key => client.del(mapKey(key)),
    hGet: (key, field) => client.hGet(mapKey(key), field),
    hGetAll: key => client.hGetAll(mapKey(key)),
    lRange: (key, start, end) => client.lRange(mapKey(key), start, end),
    eval: (script, options) => client.eval(script, { keys: options.keys.map(mapKey), arguments: options.arguments }),
  }
  const service = new ManagerIdentity(async () => adapter, 'local-integration-admin')
  const create = (username: string) => service.createUser({ username, name: username, password: 'password-123' })
  beforeAll(async () => { client.on('error', () => undefined); await client.connect() })
  afterAll(async () => {
    if (client.isOpen) {
      try { if (touched.size) await client.del([...touched]) } finally { await client.disconnect() }
    }
  })

  test('Lua enforces atomic uniqueness and assignment CAS with exactly one audit entry', async () => {
    const creation = await Promise.allSettled([create('Unique'), create('UNIQUE')])
    expect(creation.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(creation.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    const a = await create('lua-a')
    const b = await create('lua-b')
    const phone = '5511999999999'
    const assignment = await Promise.allSettled([
      service.assign(phone, a.id, null, 'admin'),
      service.assign(phone, b.id, null, 'admin'),
    ])
    const owner = await service.owner(phone)
    expect(assignment.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(assignment.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, details: { current_owner: owner } } })
    expect((await service.assignments()).history).toEqual([expect.objectContaining({ phone, from: null, to: owner, actor: 'admin' })])
    await service.assign(phone, null, owner, 'admin')
    await expect(service.assign(phone, a.id, owner, 'admin')).rejects.toMatchObject({ status: 409, details: { current_owner: null } })
    expect((await service.assignments()).history).toHaveLength(2)
    await expect(service.assign(phone, 'missing', null, 'admin')).rejects.toMatchObject({ status: 400 })
    expect((await service.assignments()).history).toHaveLength(2)
  })

  test('Lua caps audit history at 10000 and identity records have no TTL', async () => {
    const user = await create('history-user')
    await client.rPush(mapKey('manager-identity:{v1}:history'), Array(10000).fill(JSON.stringify({ phone: 'old' })))
    await service.assign('5511888888888', user.id, null, 'admin')
    expect((await service.assignments()).history).toHaveLength(10000)
    for (const suffix of ['users', 'names', 'history', 'assignments']) expect(await client.ttl(mapKey(`manager-identity:{v1}:${suffix}`))).toBe(-1)
  })

  test('Lua rate buckets reject attempt eleven and have a fifteen-minute TTL', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 11 }, () => service.login('admin', 'local-integration-admin', 'lua-ip')))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(10)
    expect(attempts.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 429 } })
    for (const key of [...touched].filter(key => key.includes('rate:'))) {
      const ttl = await client.ttl(key)
      expect(ttl).toBeGreaterThan(890)
      expect(ttl).toBeLessThanOrEqual(900)
    }
    const sessionKey = [...touched].find(key => key.includes('login:'))!
    expect(await client.ttl(sessionKey)).toBeGreaterThan(43190)
    expect(await client.ttl(sessionKey)).toBeLessThanOrEqual(43200)
  })

  test('Lua updates generations, touches API keys, and revokes without resurrection', async () => {
    const user = await create('lifecycle')
    const session = await service.login('lifecycle', 'password-123', 'lifecycle-ip')
    const key = await service.createKey(user.id, { name: 'Lua key' })
    await service.updateUser(user.id, { active: false })
    expect(await service.authenticate(key.token)).toBeUndefined()
    await service.updateUser(user.id, { active: true })
    expect(await service.authenticate(session.token)).toBeUndefined()
    expect(await service.authenticate(key.token)).toMatchObject({ kind: 'api' })
    expect((await service.keys(user.id))[0].last_used_at).not.toBeNull()
    await service.changePassword(user.id, 'password-123', 'changed-password')
    expect(await service.authenticate(key.token)).toBeDefined()
    await service.revokeKey(user.id, key.key.id)
    expect(await service.authenticate(key.token)).toBeUndefined()
    expect((await service.keys(user.id))[0].revoked).toBe(true)
    await service.createKey(user.id, { name: 'Another' })
    await service.revokeKeys(user.id)
    expect((await service.keys(user.id)).every(item => item.revoked)).toBe(true)
    expect(await service.keys('admin')).toEqual([])
  })
})
