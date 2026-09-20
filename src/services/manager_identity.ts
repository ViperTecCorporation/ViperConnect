import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'crypto'

export class ManagerError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'ManagerError'
  }
}

export interface ManagerUser {
  id: string
  name: string
  username: string
  role: 'admin' | 'user'
  active: boolean
}
export interface ManagerPrincipal extends ManagerUser {
  credentialId: string
  kind: 'login' | 'api' | 'stack'
  phones: string[]
}
export interface ManagerKey {
  id: string
  userId: string
  name: string
  createdAt: string
  expiresAt: string
  prefix: string
  created_at: string
  expires_at: string
  last_used_at: string | null
  revoked: boolean
}
interface StoredUser extends ManagerUser { password: string; generation: string }
interface Credential { userId: string; id: string; generation: string }
export interface ManagerAssignmentEvent { phone: string; from: string | null; to: string | null; at: string; actor: string }

// Deliberately outside unoapi session/auth namespaces. No TTL on identity or audit records.
const PREFIX = 'manager-identity:{v1}:'
const USERS = `${PREFIX}users`
const NAMES = `${PREFIX}names`
const ASSIGNMENTS = `${PREFIX}assignments`
const HISTORY = `${PREFIX}history`
const KEYS = `${PREFIX}keys`
const DIGESTS = `${PREFIX}digests`
const LOGIN_TTL = 12 * 60 * 60

export interface ManagerRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options: { EX: number }): Promise<unknown>
  del(key: string): Promise<unknown>
  hGet(key: string, field: string): Promise<string | undefined | null>
  hGetAll(key: string): Promise<Record<string, string>>
  lRange(key: string, start: number, end: number): Promise<string[]>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const CREATE_USER = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1`
const UPDATE_USER = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`
const ASSIGN = `
local current = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if current ~= ARGV[2] then return cjson.encode({conflict=true, current_owner=current}) end
if ARGV[3] ~= '' then
  local raw = redis.call('HGET', KEYS[3], ARGV[3])
  if not raw or not cjson.decode(raw).active then return cjson.encode({invalid=true}) end
end
if current ~= ARGV[3] then
  if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1])
  else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
  redis.call('LPUSH', KEYS[2], ARGV[4])
  redis.call('LTRIM', KEYS[2], 0, 9999)
end
return cjson.encode({ok=true})`
const RATE = `
local blocked = false
for _, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, 900) end
  if count > 10 then blocked = true end
end
if blocked then return 0 end
return 1`
const CREATE_KEY = `
local user = redis.call('HGET', KEYS[3], ARGV[1])
if not user or not cjson.decode(user).active then return 0 end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[2])
return 1`
const REVOKE_KEYS = `
local rows = redis.call('HGETALL', KEYS[1])
for i=1,#rows,2 do
  local key = cjson.decode(rows[i+1])
  if key.userId == ARGV[1] and (ARGV[2] == '' or key.id == ARGV[2]) then
    key.revoked = true
    redis.call('HSET', KEYS[1], rows[i], cjson.encode(key))
    redis.call('HDEL', KEYS[2], key.digest)
  end
end
return 1`
// Validate and touch atomically so authentication cannot resurrect a revoked key.
const TOUCH_KEY = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local key = cjson.decode(raw)
if key.revoked or key.digest ~= ARGV[2] then return 0 end
key.last_used_at = ARGV[3]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(key))
return 1`

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'))
const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ManagerError(400, `Invalid ${field}`)
  return value.trim()
}
const inputObject = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagerError(400, 'Invalid input')
}
const username = (value: unknown) => {
  const name = text(value, 'username', 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.@-]*$/.test(name)) throw new ManagerError(400, 'Invalid username')
  return name
}
const password = (value: unknown) => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new ManagerError(400, 'Password must contain 8 to 256 characters')
  return value
}
const phoneNumber = (value: unknown) => {
  if (typeof value !== 'string' || !/^\+?\d{8,15}$/.test(value)) throw new ManagerError(400, 'Invalid phone')
  return value.replace(/^\+/, '')
}
const derive = (value: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(value, salt, 64, (error, key) => error ? reject(error) : resolve(key))
})
const hashPassword = async (value: string) => {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await derive(value, salt)).toString('hex')}`
}
const checkPassword = async (value: string, stored: string) => {
  const [salt, hash] = stored.split(':')
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false
  return timingSafeEqual(await derive(value, salt), Buffer.from(hash, 'hex'))
}
const publicUser = (user: ManagerUser): ManagerUser => ({ id: user.id, name: user.name, username: user.username, role: user.role, active: user.active })
const publicKey = (key: ManagerKey): ManagerKey => ({
  id: key.id, userId: key.userId, name: key.name,
  createdAt: key.createdAt, expiresAt: key.expiresAt,
  // Older records have no prefix; never derive a display value from their digest.
  prefix: key.prefix || 'mgr_key_', created_at: key.createdAt, expires_at: key.expiresAt,
  last_used_at: key.last_used_at || null, revoked: key.revoked === true,
})

// Factory import stays lazy: injecting Redis does not start the application's Redis subsystem.
const defaultRedis = async (): Promise<ManagerRedis> => {
  const { getRedis } = await import('./redis.js')
  return await getRedis() as unknown as ManagerRedis
}

export class ManagerIdentity {
  constructor(private getRedis: () => Promise<ManagerRedis> = defaultRedis, private adminToken = process.env.UNOAPI_AUTH_TOKEN || '') {}

  private async run<T>(action: (redis: ManagerRedis) => Promise<T>): Promise<T> {
    try { return await action(await this.getRedis()) } catch (error) {
      if (error instanceof ManagerError) throw error
      // Never propagate Redis errors, arguments, password hashes or tokens to HTTP/logging callers.
      throw new ManagerError(503, 'Manager identity storage unavailable')
    }
  }

  private async user(redis: ManagerRedis, id: string): Promise<StoredUser> {
    const raw = await redis.hGet(USERS, text(id, 'user id', 64))
    if (!raw) throw new ManagerError(404, 'User not found')
    return JSON.parse(raw)
  }

  private admin(): ManagerUser { return { id: 'admin', name: 'Administrator', username: 'admin', role: 'admin', active: true } }

  async login(name: string, secret: string, ip: string) {
    const normalized = username(name)
    text(ip, 'IP address', 128)
    if (typeof secret !== 'string' || secret.length > 4096) throw new ManagerError(400, 'Invalid password')
    return this.run(async redis => {
      const allowed = await redis.eval(RATE, { keys: [`${PREFIX}rate:user:${digest(normalized)}`, `${PREFIX}rate:ip:${digest(ip)}`], arguments: [] })
      if (Number(allowed) !== 1) throw new ManagerError(429, 'Too many login attempts')
      let user: ManagerUser
      let generation: string
      if (normalized === 'admin') {
        if (!this.adminToken || !equal(secret, this.adminToken)) throw new ManagerError(401, 'Invalid credentials')
        user = this.admin()
        generation = digest(this.adminToken)
      } else {
        const id = await redis.hGet(NAMES, normalized)
        const raw = id ? await redis.hGet(USERS, id) : null
        const stored: StoredUser | undefined = raw ? JSON.parse(raw) : undefined
        // Same scrypt cost for unknown usernames; bounded by both rate buckets.
        const valid = await checkPassword(secret, stored?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`)
        if (!stored || !stored.active || !valid) throw new ManagerError(401, 'Invalid credentials')
        user = stored
        generation = stored.generation
      }
      const token = `mgr_login_${randomBytes(32).toString('hex')}`
      await redis.set(`${PREFIX}login:${digest(token)}`, JSON.stringify({ userId: user.id, id: randomUUID(), generation }), { EX: LOGIN_TTL })
      return { token, user: publicUser(user) }
    })
  }

  async authenticate(token: string): Promise<ManagerPrincipal | undefined> {
    if (typeof token !== 'string' || !token || token.length > 4096) return undefined
    return this.run(async redis => {
      // Read Redis even for stack admin: an unavailable store never grants access.
      const assignments = await redis.hGetAll(ASSIGNMENTS)
      if (this.adminToken && equal(token, this.adminToken)) return { ...this.admin(), credentialId: 'stack', kind: 'stack', phones: Object.keys(assignments) }
      let credential: Credential
      let kind: 'login' | 'api'
      if (/^mgr_login_[a-f0-9]{64}$/.test(token)) {
        const raw = await redis.get(`${PREFIX}login:${digest(token)}`)
        if (!raw) return undefined
        credential = JSON.parse(raw)
        kind = 'login'
      } else if (/^mgr_key_[a-f0-9]{64}$/.test(token)) {
        const id = await redis.hGet(DIGESTS, digest(token))
        const raw = id ? await redis.hGet(KEYS, id) : null
        if (!raw) return undefined
        const key = JSON.parse(raw)
        if (key.revoked || !Number.isFinite(Date.parse(key.expiresAt)) || Date.parse(key.expiresAt) <= Date.now()) return undefined
        credential = { userId: key.userId, id: key.id, generation: '' }
        kind = 'api'
      } else return undefined
      if (credential.userId === 'admin') {
        if (kind !== 'login' || !this.adminToken || credential.generation !== digest(this.adminToken)) return undefined
        return { ...this.admin(), kind, credentialId: credential.id, phones: Object.keys(assignments) }
      }
      const raw = await redis.hGet(USERS, credential.userId)
      if (!raw) return undefined
      const user: StoredUser = JSON.parse(raw)
      if (!user.active || (kind === 'login' && credential.generation !== user.generation)) return undefined
      if (kind === 'api' && Number(await redis.eval(TOUCH_KEY, { keys: [KEYS], arguments: [credential.id, digest(token), new Date().toISOString()] })) !== 1) return undefined
      return { ...publicUser(user), kind, credentialId: credential.id, phones: Object.keys(assignments).filter(phone => assignments[phone] === user.id) }
    })
  }

  async users() {
    return this.run(async redis => {
      const [rows, assignments] = await Promise.all([redis.hGetAll(USERS), redis.hGetAll(ASSIGNMENTS)])
      return Object.values(rows).map(raw => {
        const user = publicUser(JSON.parse(raw))
        return { ...user, phones: Object.keys(assignments).filter(phone => assignments[phone] === user.id) }
      })
    })
  }

  async createUser(input: { username: string; name: string; password: string }) {
    inputObject(input)
    const name = username(input.username)
    if (name === 'admin') throw new ManagerError(400, 'Reserved username')
    const user: StoredUser = { id: randomUUID(), username: name, name: text(input.name, 'name', 128), role: 'user', active: true, generation: randomUUID(), password: await hashPassword(password(input.password)) }
    return this.run(async redis => {
      if (Number(await redis.eval(CREATE_USER, { keys: [NAMES, USERS], arguments: [name, user.id, JSON.stringify(user)] })) !== 1) throw new ManagerError(409, 'Username already exists')
      return publicUser(user)
    })
  }

  async updateUser(id: string, input: { name?: string; active?: boolean; password?: string }) {
    inputObject(input)
    const patch: Partial<StoredUser> = {}
    if (input.name !== undefined) patch.name = text(input.name, 'name', 128)
    if (input.active !== undefined) {
      if (typeof input.active !== 'boolean') throw new ManagerError(400, 'Invalid active flag')
      patch.active = input.active
      // API keys are suspended while inactive and may resume; old logins never resume.
      if (!input.active) patch.generation = randomUUID()
    }
    if (input.password !== undefined) { patch.password = await hashPassword(password(input.password)); patch.generation = randomUUID() }
    return this.run(async redis => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const old = await this.user(redis, id)
        const user = { ...old, ...patch }
        if (Number(await redis.eval(UPDATE_USER, { keys: [USERS], arguments: [id, JSON.stringify(old), JSON.stringify(user)] })) === 1) return publicUser(user)
      }
      throw new ManagerError(409, 'User changed concurrently')
    })
  }

  async assignments() {
    return this.run(async redis => ({ assignments: await redis.hGetAll(ASSIGNMENTS), history: (await redis.lRange(HISTORY, 0, 9999)).map(raw => JSON.parse(raw) as ManagerAssignmentEvent) }))
  }

  async assign(phone: string, userId: string | null, expectedOwner: string | null, actor: string) {
    phone = phoneNumber(phone)
    if (userId !== null) text(userId, 'user id', 64)
    if (expectedOwner !== null) text(expectedOwner, 'expected owner', 64)
    const event: ManagerAssignmentEvent = { phone, from: expectedOwner, to: userId, at: new Date().toISOString(), actor: text(actor, 'actor', 128) }
    return this.run(async redis => {
      const result = JSON.parse(String(await redis.eval(ASSIGN, { keys: [ASSIGNMENTS, HISTORY, USERS], arguments: [phone, expectedOwner || '', userId || '', JSON.stringify(event)] })))
      if (result.conflict) throw new ManagerError(409, 'Assignment changed concurrently', { current_owner: result.current_owner || null })
      if (result.invalid) throw new ManagerError(400, 'Assignment requires an active user')
      return { phone, userId }
    })
  }

  async owner(phone: string): Promise<string | null> {
    const normalized = phoneNumber(phone)
    return this.run(async redis => (await redis.hGet(ASSIGNMENTS, normalized)) || null)
  }

  async keys(userId: string) {
    return this.run(async redis => {
      if (userId === 'admin') { await redis.hGetAll(KEYS); return [] as ManagerKey[] }
      await this.user(redis, userId)
      return Object.values(await redis.hGetAll(KEYS)).map(raw => JSON.parse(raw)).filter(key => key.userId === userId).map(publicKey)
    })
  }

  async createKey(userId: string, input: { name: string; days?: number }) {
    inputObject(input)
    const name = text(input.name, 'key name', 128)
    const days = input.days === undefined ? 90 : input.days
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 365) throw new ManagerError(400, 'Invalid key validity')
    const token = `mgr_key_${randomBytes(32).toString('hex')}`
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString()
    const key: ManagerKey = { id: randomUUID(), userId: text(userId, 'user id', 64), name, createdAt, expiresAt, prefix: token.slice(0, 16), created_at: createdAt, expires_at: expiresAt, last_used_at: null, revoked: false }
    return this.run(async redis => {
      if (Number(await redis.eval(CREATE_KEY, { keys: [KEYS, DIGESTS, USERS], arguments: [userId, key.id, JSON.stringify({ ...key, digest: digest(token) }), digest(token)] })) !== 1) throw new ManagerError(400, 'Key requires an active user')
      return { token, key }
    })
  }

  async revokeKey(userId: string, keyId: string) { return this.revoke(userId, text(keyId, 'key id', 64)) }
  async revokeKeys(userId: string) { return this.revoke(userId, '') }
  private async revoke(userId: string, keyId: string) {
    return this.run(async redis => {
      await this.user(redis, userId)
      await redis.eval(REVOKE_KEYS, { keys: [KEYS, DIGESTS], arguments: [userId, keyId] })
    })
  }

  async logout(token: string) {
    if (typeof token !== 'string' || !/^mgr_login_[a-f0-9]{64}$/.test(token)) return
    await this.run(async redis => { await redis.del(`${PREFIX}login:${digest(token)}`) })
  }

  async changePassword(userId: string, current: string, next: string) {
    password(next)
    if (typeof current !== 'string' || current.length > 256) throw new ManagerError(400, 'Invalid current password')
    return this.run(async redis => {
      const old = await this.user(redis, userId)
      if (!old.active || !(await checkPassword(current, old.password))) throw new ManagerError(401, 'Invalid credentials')
      const user = { ...old, password: await hashPassword(next), generation: randomUUID() }
      if (Number(await redis.eval(UPDATE_USER, { keys: [USERS], arguments: [userId, JSON.stringify(old), JSON.stringify(user)] })) !== 1) throw new ManagerError(409, 'User changed concurrently')
      return publicUser(user)
    })
  }
}

export const managerIdentity = new ManagerIdentity()
