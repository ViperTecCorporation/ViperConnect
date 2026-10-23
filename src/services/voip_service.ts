import { VOIP_SERVICE_TOKEN, VOIP_SERVICE_URL } from '../defaults'

const DEFAULT_MAX_CONCURRENT_CALLS = 2
const MAX_CONCURRENT_CALLS = 32

const records = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value : []
const LEGACY_SLOT_FIELDS = new Set(['slots', 'slot', 'slotId', 'deviceSlotIds'])

const withoutLegacyConsoleIdentity = (value: Record<string, any>) => {
  const { users: _users, auth: _auth, ...current } = value
  return current
}

export const sanitizeVoipConsolePayload = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => sanitizeVoipConsolePayload(item)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !LEGACY_SLOT_FIELDS.has(key))
      .map(([key, item]) => [key, key === 'viperchatWebhook' && item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).filter(([field, fieldValue]) =>
          ['enabled', 'hasApiAccessToken'].includes(field) ? typeof fieldValue === 'boolean'
            : field === 'artifactsDelivery' ? ['legacy', 'webhook'].includes(`${fieldValue}`) && typeof fieldValue === 'string'
              : ['baseUrl', 'accountId', 'serviceId', 'sourceInstanceId'].includes(field) && typeof fieldValue === 'string'))
        : sanitizeVoipConsolePayload(item)]),
  ) as T
}

export const normalizeVoipMaxConcurrentCalls = (value: unknown, fallback = DEFAULT_MAX_CONCURRENT_CALLS) => {
  const parsed = Number(value)
  const effective = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
  return Math.min(MAX_CONCURRENT_CALLS, Math.max(2, effective))
}

const legacyLineConcurrency = (account: Record<string, any>) => {
  const total = records(account.slots)
    .filter(slot => slot.enabled !== false)
    .reduce((sum, slot) => {
      const value = Number(slot.maxActiveCalls)
      return sum + Math.min(MAX_CONCURRENT_CALLS, Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1))
    }, 0)
  return total > 0 ? total : undefined
}

export const normalizeVoipAdminState = (value: Record<string, any>) => {
  const nestedConfig = value.config && typeof value.config === 'object' ? value.config as Record<string, any> : undefined
  const sourceAccounts = records(value.accounts ?? nestedConfig?.accounts)
  const sourceSessions = records(value.sessions ?? nestedConfig?.sessions)
  const accountLimits = new Map<string, number>()

  const accounts = sourceAccounts.map(account => {
    const maxConcurrentCalls = normalizeVoipMaxConcurrentCalls(
      account.maxConcurrentCalls,
      legacyLineConcurrency(account) ?? DEFAULT_MAX_CONCURRENT_CALLS,
    )
    const normalized: Record<string, any> = { ...account, maxConcurrentCalls }
    delete normalized.slots
    for (const key of [account.id, account.phoneNumber]) {
      if (key) accountLimits.set(`${key}`, maxConcurrentCalls)
    }
    return normalized
  })

  const sessions = sourceSessions.map(session => {
    const fallback = accountLimits.get(`${session.accountId || ''}`)
      ?? accountLimits.get(`${session.unoSession || ''}`)
      ?? DEFAULT_MAX_CONCURRENT_CALLS
    const normalized: Record<string, any> = {
      ...session,
      maxConcurrentCalls: normalizeVoipMaxConcurrentCalls(session.maxConcurrentCalls, fallback),
    }
    delete normalized.deviceSlotIds
    return normalized
  })

  const zapoLines = records(value.zapoLines).map(line => {
    const fallback = accountLimits.get(`${line.accountId || ''}`)
      ?? accountLimits.get(`${line.session || ''}`)
      ?? DEFAULT_MAX_CONCURRENT_CALLS
    const normalized: Record<string, any> = {
      ...line,
      maxConcurrentCalls: normalizeVoipMaxConcurrentCalls(line.maxConcurrentCalls, fallback),
    }
    delete normalized.slotId
    return normalized
  })

  const normalizedConfig = nestedConfig
    ? { ...withoutLegacyConsoleIdentity(nestedConfig), accounts, sessions }
    : undefined
  return sanitizeVoipConsolePayload({
    ...withoutLegacyConsoleIdentity(value),
    ...(normalizedConfig ? { config: normalizedConfig } : {}),
    accounts,
    sessions,
    zapoLines,
  })
}

export class VoipServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'VoipServiceError'
  }
}

export class VoipService {
  constructor(
    private readonly baseUrl = VOIP_SERVICE_URL,
    private readonly token = VOIP_SERVICE_TOKEN,
    private readonly timeoutMs = Number(process.env.VOIP_SERVICE_TIMEOUT_MS || 10_000),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  available() {
    return !!this.baseUrl.trim() && !!this.token.trim()
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.available()) throw new VoipServiceError(503, 'voip_service_not_configured')
    if (!path.startsWith('/v1/')) throw new VoipServiceError(400, 'invalid_voip_service_path')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, this.timeoutMs))
    timer.unref?.()
    try {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${this.token}`)
      if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      const response = await this.fetcher(new URL(path, this.baseUrl).toString(), { ...init, headers, signal: controller.signal })
      const text = await response.text()
      let payload: unknown
      try {
        payload = text ? JSON.parse(text) : undefined
      } catch {
        payload = text
      }
      if (!response.ok) {
        const message =
          payload && typeof payload === 'object'
            ? `${(payload as any).message || (payload as any).error || 'voip_service_error'}`
            : 'voip_service_error'
        throw new VoipServiceError(response.status, message, payload)
      }
      return payload as T
    } catch (error) {
      if (error instanceof VoipServiceError) throw error
      if ((error as any)?.name === 'AbortError') throw new VoipServiceError(504, 'voip_service_timeout')
      throw new VoipServiceError(502, 'voip_service_unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  async stream(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.available()) throw new VoipServiceError(503, 'voip_service_not_configured')
    if (!path.startsWith('/v1/')) throw new VoipServiceError(400, 'invalid_voip_service_path')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, this.timeoutMs))
    timer.unref?.()
    try {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${this.token}`)
      const response = await this.fetcher(new URL(path, this.baseUrl).toString(), { ...init, headers, signal: controller.signal })
      if (!response.ok) {
        const text = await response.text()
        let payload: unknown = text
        try { payload = text ? JSON.parse(text) : undefined } catch {}
        const message = payload && typeof payload === 'object'
          ? `${(payload as any).message || (payload as any).error || 'voip_service_error'}`
          : 'voip_service_error'
        throw new VoipServiceError(response.status, message, payload)
      }
      return response
    } catch (error) {
      if (error instanceof VoipServiceError) throw error
      if ((error as any)?.name === 'AbortError') throw new VoipServiceError(504, 'voip_service_timeout')
      throw new VoipServiceError(502, 'voip_service_unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  async bootstrap() {
    const [consoleState, bridges, calls, history, recordingSummary] = await Promise.all([
      this.request<any>('/v1/console/bootstrap'),
      this.request<any>('/v1/zapo/bridges'),
      this.request<any>('/v1/zapo/calls'),
      this.request<any>('/v1/console/history?limit=20'),
      this.request<any>('/v1/console/recording/summary'),
    ])
    return normalizeVoipAdminState({
      ...consoleState,
      ...(consoleState.config || {}),
      ...bridges,
      ...calls,
      history,
      recordingSummary,
    })
  }
}
