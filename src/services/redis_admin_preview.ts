const managerPrefix = 'manager-identity:{v1}:'
export const managerPreviewKeys = ['users', 'names', 'assignments', 'history', 'keys'].map(name => `${managerPrefix}${name}`)
export const protectedRedisPrefixes = ['manager-identity:', 'unoapi-webhook-history:']
export const isProtectedRedisKey = (key: string) => protectedRedisPrefixes.some(prefix => key.startsWith(prefix))

// Positive field selection: unknown fields, hashes and nested credentials never leave Redis.
const record = (raw: unknown): Record<string, any> => {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
const pick = (value: Record<string, any>, fields: string[]) => Object.fromEntries(fields
  .filter(field => ['string', 'number', 'boolean'].includes(typeof value[field]) || value[field] === null)
  .map(field => [field, value[field]]))

export const safeRedisPreview = (key: string, raw: unknown): unknown => {
  const value = record(raw)
  if (key.startsWith('unoapi-webhook-history:')) {
    return {
      ...pick(value, ['id', 'archived_at', 'reason', 'server']),
      webhooks: (Array.isArray(value.webhooks) ? value.webhooks : []).map((rawHook: unknown) => {
        const hook = record(rawHook)
        let destination = ''
        try {
          const url = new URL(hook.urlAbsolute || hook.url)
          if (['http:', 'https:'].includes(url.protocol)) destination = url.origin
        } catch { /* Invalid URLs must not expose their original text. */ }
        return {
          ...pick(hook, ['id', 'enabled', 'disabled']), destination,
          has_credentials: !!(hook.token || hook.header),
          events: Object.keys(hook).filter(field => /^send[A-Za-z]+$/.test(field) && hook[field] === true),
        }
      }),
    }
  }
  if (key === `${managerPrefix}users`) return pick(value, ['id', 'name', 'username', 'role', 'active'])
  if (key === `${managerPrefix}keys`) return pick(value, ['id', 'userId', 'name', 'prefix', 'createdAt', 'expiresAt', 'created_at', 'expires_at', 'last_used_at', 'revoked'])
  if (key === `${managerPrefix}history`) return pick(value, ['phone', 'from', 'to', 'at', 'actor'])
  if (key === `${managerPrefix}assignments` || key === `${managerPrefix}names`) return typeof raw === 'string' ? raw : null
  return '[REDACTED]'
}
