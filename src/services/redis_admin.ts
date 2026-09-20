import { getRedis, redisScanSome } from './redis'
import { redactLogValue } from './log_redaction'
import { isProtectedRedisKey, managerPreviewKeys, protectedRedisPrefixes, safeRedisPreview } from './redis_admin_preview'

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'none'

export type RedisKeyDetails = {
  key: string
  type: RedisKeyType
  ttl: number
  size: number
  truncated: boolean
  value: unknown
  readOnly?: boolean
}

export type RedisTreeNode = {
  label: string
  path: string
  kind: 'branch' | 'key'
  descendantCount?: number
}

export class RedisAdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'RedisAdminError'
  }
}

const allowedPrefixes = ['unoapi-', 'unoapi:']
const knownRedisRootNodes: RedisTreeNode[] = [
  'unoapi-profile-picture:',
  'unoapi-profile-picture-miss:',
  'unoapi-profile-picture-webhook:',
  'unoapi-profile-picture-refresh:',
].map((path) => ({
  label: path.slice(0, -1),
  path,
  kind: 'branch',
  descendantCount: 0,
}))

export const isAllowedRedisKey = (key: string): boolean =>
  allowedPrefixes.some((prefix) => `${key || ''}`.startsWith(prefix)) || managerPreviewKeys.includes(key)

const redisTreePatterns = (prefix: string): string[] => {
  if (!prefix) return [...allowedPrefixes.map((allowed) => `${allowed}*`), ...managerPreviewKeys]
  if (prefix === 'manager-identity:' || prefix === 'manager-identity:{v1}:') return managerPreviewKeys
  if (/[*?[\]]/.test(prefix) || !isAllowedRedisKey(prefix)) {
    throw new RedisAdminError(403, 'redis_key_not_allowed')
  }
  return [`${prefix}*`]
}

export const redisTreeNodes = (keys: string[], prefix = ''): RedisTreeNode[] => {
  const nodes = new Map<string, RedisTreeNode>()
  keys.forEach((key) => {
    if (!key.startsWith(prefix)) return
    const remainder = key.slice(prefix.length)
    const separator = remainder.indexOf(':')
    const label = separator >= 0 ? remainder.slice(0, separator) : remainder
    if (!label) return
    const kind = separator >= 0 ? 'branch' : 'key'
    const path = kind === 'branch' ? `${prefix}${label}:` : key
    const current = nodes.get(path)
    if (kind === 'branch') {
      nodes.set(path, {
        label,
        path,
        kind,
        descendantCount: (current?.descendantCount || 0) + 1,
      })
    } else if (!current) {
      nodes.set(path, { label, path, kind })
    }
  })
  return [...nodes.values()]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'branch' ? -1 : 1
      return left.label.localeCompare(right.label)
    })
}

export const includeKnownRedisRootNodes = (nodes: RedisTreeNode[]): RedisTreeNode[] => {
  const merged = new Map<string, RedisTreeNode>()
  const allNodes = [...knownRedisRootNodes, ...nodes]
  allNodes.forEach((node) => merged.set(node.path, node))
  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label))
}

export const parseRedisValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return redactLogValue(value)
  try {
    return redactLogValue(JSON.parse(value))
  } catch {
    return redactLogValue(value)
  }
}

export const containsRedactedValue = (value: unknown): boolean => {
  if (value === '[REDACTED]') return true
  if (Array.isArray(value)) return value.some(containsRedactedValue)
  if (value && typeof value === 'object') return Object.values(value).some(containsRedactedValue)
  return false
}

export class RedisAdmin {
  constructor(private readonly clientFactory: typeof getRedis = getRedis) {}

  private assertKey(key: string): void {
    if (!isAllowedRedisKey(key)) throw new RedisAdminError(403, 'redis_key_not_allowed')
  }

  private assertWritable(key: string): void {
    if (/[*?[\]]/.test(key)) throw new RedisAdminError(403, 'redis_key_not_allowed')
    if (protectedRedisPrefixes.some(prefix => key.startsWith(prefix) || prefix.startsWith(key))) {
      throw new RedisAdminError(403, 'redis_key_read_only')
    }
    this.assertKey(key)
  }

  private assertPrefix(prefix: string): void {
    this.assertKey(prefix)
    if (!prefix.endsWith(':')) throw new RedisAdminError(400, 'redis_prefix_required')
  }

  private async scanTreeKeys(patterns: string[]): Promise<string[]> {
    const client: any = await this.clientFactory()
    const keys = new Set<string>()
    for (const pattern of patterns) {
      let cursor = '0'
      do {
        const result: any = await client.scan(cursor, { MATCH: pattern, COUNT: 1000 })
        cursor = typeof result.cursor !== 'undefined' ? `${result.cursor}` : `${result[0]}`
        const page: string[] = Array.isArray(result.keys) ? result.keys : (result[1] || [])
        page.filter(isAllowedRedisKey).forEach((key) => keys.add(key))
      } while (cursor !== '0')
    }
    return [...keys]
  }

  async listKeys(search = '', limit = 200): Promise<string[]> {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
    const term = `${search || ''}`.trim().replace(/[*?[\]]/g, '')
    const patterns = isAllowedRedisKey(term)
      ? [`${term}*`]
      : [...allowedPrefixes.map((prefix) => `${prefix}*${term}*`), ...managerPreviewKeys.filter(key => key.includes(term))]
    const groups = await Promise.all(
      patterns.map((pattern) => redisScanSome(pattern, safeLimit)),
    )
    const keys: string[] = []
    const seen = new Set<string>()
    const sortedGroups = groups.map((group) => [...group].filter(isAllowedRedisKey).sort())
    for (let index = 0; keys.length < safeLimit; index += 1) {
      let found = false
      for (const group of sortedGroups) {
        const key = group[index]
        if (!key) continue
        found = true
        if (!seen.has(key)) {
          seen.add(key)
          keys.push(key)
          if (keys.length >= safeLimit) break
        }
      }
      if (!found) break
    }
    return keys
  }

  async listTree(prefix = '', limit = 100): Promise<RedisTreeNode[]> {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100))
    const normalizedPrefix = `${prefix || ''}`.trim()
    const keys = await this.scanTreeKeys(redisTreePatterns(normalizedPrefix))
    const nodes = redisTreeNodes(keys, normalizedPrefix)
    return (normalizedPrefix ? nodes : includeKnownRedisRootNodes(nodes)).slice(0, safeLimit)
  }

  async getKey(key: string): Promise<RedisKeyDetails> {
    this.assertKey(key)
    const client: any = await this.clientFactory()
    const type = `${await client.type(key)}` as RedisKeyType
    const ttl = Number(await client.ttl(key))
    if (isProtectedRedisKey(key)) {
      let size = 0
      let value: unknown = null
      if (type === 'list') {
        size = Number(await client.lLen(key))
        value = (await client.lRange(key, 0, 199)).map((raw: unknown) => safeRedisPreview(key, raw))
      } else if (type === 'hash') {
        const data = await client.hGetAll(key)
        size = Number(await client.hLen(key))
        value = Object.fromEntries(Object.entries(data).slice(0, 200).map(([field, raw]) => [field, safeRedisPreview(key, raw)]))
      }
      return { key, type, ttl, size, truncated: size > 200, value, readOnly: true }
    }
    let value: unknown = null
    let size = 0
    let truncated = false
    if (type === 'string') {
      value = parseRedisValue(await client.get(key))
      size = typeof value === 'string' ? value.length : JSON.stringify(value).length
    } else if (type === 'hash') {
      const data = await client.hGetAll(key)
      size = Number(await client.hLen(key))
      truncated = size > 200
      value = parseRedisValue(Object.fromEntries(Object.entries(data).slice(0, 200)))
    } else if (type === 'list') {
      size = Number(await client.lLen(key))
      truncated = size > 200
      value = parseRedisValue(await client.lRange(key, 0, 199))
    } else if (type === 'set') {
      const data = await client.sMembers(key)
      size = Number(await client.sCard(key))
      truncated = size > 200
      value = parseRedisValue(data.slice(0, 200))
    } else if (type === 'zset') {
      size = Number(await client.zCard(key))
      truncated = size > 200
      value = parseRedisValue(await client.zRangeWithScores(key, 0, 199))
    } else if (type === 'stream') {
      size = Number(await client.xLen(key))
      truncated = size > 100
      value = parseRedisValue(await client.xRange(key, '-', '+', { COUNT: 100 }))
    }
    return { key, type, ttl, size, truncated, value }
  }

  async saveKey(key: string, type: RedisKeyType, value: unknown, ttlSeconds = -1): Promise<void> {
    this.assertWritable(key)
    if (!['string', 'hash', 'list', 'set', 'zset'].includes(type)) {
      throw new RedisAdminError(400, 'redis_type_not_editable')
    }
    if (containsRedactedValue(value)) {
      throw new RedisAdminError(400, 'redis_redacted_value_cannot_be_saved')
    }
    if (type === 'hash' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new RedisAdminError(400, 'redis_hash_object_required')
    }
    if (type === 'hash' && !Object.keys(value as object).length) {
      throw new RedisAdminError(400, 'redis_collection_cannot_be_empty')
    }
    if (['list', 'set', 'zset'].includes(type) && !Array.isArray(value)) {
      throw new RedisAdminError(400, type === 'zset' ? 'redis_zset_array_required' : 'redis_array_required')
    }
    if (Array.isArray(value) && ['list', 'set', 'zset'].includes(type) && !value.length) {
      throw new RedisAdminError(400, 'redis_collection_cannot_be_empty')
    }
    const client: any = await this.clientFactory()
    const transaction = client.multi()
    transaction.del(key)
    if (type === 'string') {
      transaction.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    } else if (type === 'hash') {
      transaction.hSet(key, Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [field, typeof item === 'string' ? item : JSON.stringify(item)])))
    } else if (type === 'list') {
      transaction.rPush(key, (value as unknown[]).map((item) => typeof item === 'string' ? item : JSON.stringify(item)))
    } else if (type === 'set') {
      transaction.sAdd(key, (value as unknown[]).map((item) => typeof item === 'string' ? item : JSON.stringify(item)))
    } else if (type === 'zset') {
      transaction.zAdd(key, (value as any[]).map((item) => ({ value: `${item.value}`, score: Number(item.score) || 0 })))
    }
    if (ttlSeconds > 0) transaction.expire(key, Math.floor(ttlSeconds))
    await transaction.exec()
  }

  async deleteKey(key: string): Promise<number> {
    this.assertWritable(key)
    const client: any = await this.clientFactory()
    return Number(await client.del(key)) || 0
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.assertWritable(prefix)
    this.assertPrefix(prefix)
    const client: any = await this.clientFactory()
    let cursor = '0'
    let removed = 0
    do {
      const result: any = await client.scan(cursor, {
        MATCH: `${prefix}*`,
        COUNT: 500,
      })
      cursor = typeof result.cursor !== 'undefined' ? `${result.cursor}` : `${result[0]}`
      const keys: string[] = Array.isArray(result.keys) ? result.keys : (result[1] || [])
      if (keys.length) {
        const count = typeof client.unlink === 'function'
          ? await client.unlink(keys)
          : await client.del(keys)
        removed += Number(count) || 0
      }
    } while (cursor !== '0')
    return removed
  }

  async query(command: string, args: string[] = []): Promise<unknown> {
    const name = `${command || ''}`.trim().toUpperCase()
    const client: any = await this.clientFactory()
    if (name === 'SCAN') {
      return this.listKeys(args[0] || '', Number(args[1]) || 200)
    }
    const key = `${args[0] || ''}`
    this.assertKey(key)
    if (name === 'TYPE') return client.type(key)
    if (name === 'TTL') return client.ttl(key)
    if (isProtectedRedisKey(key)) {
      if (!['GET', 'HGETALL', 'LRANGE', 'SMEMBERS', 'ZRANGE'].includes(name)) throw new RedisAdminError(400, 'redis_command_not_allowed')
      return (await this.getKey(key)).value
    }
    if (name === 'GET') return parseRedisValue(await client.get(key))
    if (name === 'HGETALL') return parseRedisValue(await client.hGetAll(key))
    if (name === 'LRANGE') return parseRedisValue(await client.lRange(key, 0, 199))
    if (name === 'SMEMBERS') return parseRedisValue(await client.sMembers(key))
    if (name === 'ZRANGE') return parseRedisValue(await client.zRangeWithScores(key, 0, 199))
    throw new RedisAdminError(400, 'redis_command_not_allowed')
  }
}
