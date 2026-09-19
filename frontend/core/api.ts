import type {
  ContactDirectoryPage,
  GroupPage,
  RabbitQueueInfo,
  RabbitQueueMessage,
  RedisKeyDetails,
  RedisKeyType,
  RedisTreeNode,
  SessionConfig,
  VersionStatus,
  VoipBootstrap,
  VoipHistoryPage,
  VoipHistoryQuery,
  WebhookConfig,
} from '../domain/types.js'
import { t } from './i18n.js'
import type { SessionDestination } from '../pages/session_webhooks.js'

export class ApiError extends Error {
  get code(): string | undefined {
    const value = this.payload as { error_code?: string; error?: { error_code?: string } } | undefined
    return value?.error_code || value?.error?.error_code
  }
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Fetcher = typeof fetch

const errorMessage = (payload: unknown, status: number): string => {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    const message = value.message || value.error || value.title
    if (message) return `${message}`
  }
  return t('Falha HTTP {status}', { status })
}

export class ApiClient {
  private token = ''

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  setToken(token: string): void {
    this.token = token.trim()
  }

  getToken(): string {
    return this.token
  }

  sessionDestinations(): Promise<{ destinations: SessionDestination[] }> {
    return this.request('/admin/session-webhooks')
  }

  saveSessionDestination(payload: Record<string, unknown>, id = ''): Promise<SessionDestination> {
    return this.request(`/admin/session-webhooks${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
  }

  deleteSessionDestination(id: string): Promise<void> {
    return this.request(`/admin/session-webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    // Native browser fetch validates its receiver. Calling it as
    // `this.fetcher()` binds ApiClient as `this` and Chrome rejects the request
    // with "Illegal invocation".
    const response = await this.fetcher.call(globalThis, `${this.baseUrl}${path}`, { ...init, headers })
    if (response.status === 204) return undefined as T

    const text = await response.text()
    let payload: unknown = undefined
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    if (!response.ok) throw new ApiError(response.status, errorMessage(payload, response.status), payload)
    return payload as T
  }

  async sessions(): Promise<SessionConfig[]> {
    const response = await this.request<{ data?: SessionConfig[] }>('/sessions')
    return Array.isArray(response?.data) ? response.data : []
  }

  versionStatus(): Promise<VersionStatus> {
    return this.request<VersionStatus>('/version')
  }

  session(phone: string): Promise<SessionConfig> {
    return this.request<SessionConfig>(`/v15.0/${encodeURIComponent(phone)}`)
  }

  register(phone: string, config: Record<string, unknown> = {}): Promise<SessionConfig> {
    return this.request<SessionConfig>(`/v15.0/${encodeURIComponent(phone)}/register`, {
      method: 'POST',
      body: JSON.stringify(config),
    })
  }

  deregister(phone: string): Promise<void> {
    return this.request<void>(`/v15.0/${encodeURIComponent(phone)}/deregister`, {
      method: 'POST',
    })
  }

  contacts(phone: string, cursor = '0', limit = 20, search = ''): Promise<ContactDirectoryPage> {
    const query = new URLSearchParams({ cursor, limit: `${limit}` })
    const normalizedSearch = search.trim()
    if (normalizedSearch.length >= 3) query.set('search', normalizedSearch)
    return this.request<ContactDirectoryPage>(`/${encodeURIComponent(phone)}/contacts?${query}`)
  }

  async profilePicture(phone: string, pictureId: string): Promise<Blob | undefined> {
    const headers = new Headers()
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await this.fetcher.call(
      globalThis,
      `${this.baseUrl}/v13.0/${encodeURIComponent(phone)}/profile-pictures/${encodeURIComponent(pictureId)}`,
      { headers },
    )
    if (response.status === 404) return undefined
    if (!response.ok) {
      const text = await response.text()
      let payload: unknown = text
      try { payload = text ? JSON.parse(text) : undefined } catch {}
      throw new ApiError(response.status, errorMessage(payload, response.status), payload)
    }
    return response.blob()
  }

  groups(phone: string, cursor = '0', limit = 20, search = ''): Promise<GroupPage> {
    const query = new URLSearchParams({ cursor, limit: `${limit}` })
    if (search.trim()) query.set('search', search.trim())
    return this.request<GroupPage>(`/v15.0/${encodeURIComponent(phone)}/groups?${query}`)
  }

  webhookHistory(phone: string): Promise<{ snapshots: import('../features/webhook_history.js').WebhookHistorySnapshot[] }> {
    return this.request(`/admin/webhooks/history/${encodeURIComponent(phone)}`)
  }

  restoreWebhookHistory(phone: string, payload: object): Promise<{ restored: string[]; enabled: false }> {
    return this.request(`/admin/webhooks/history/${encodeURIComponent(phone)}/restore`, { method: 'POST', body: JSON.stringify(payload) })
  }

  saveWebhooks(phone: string, webhooks: WebhookConfig[]): Promise<SessionConfig> {
    return this.register(phone, {
      webhooks,
      overrideWebhooks: true,
    })
  }

  sendText(phone: string, to: string, body: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/v15.0/${encodeURIComponent(phone)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    })
  }

  async queues(): Promise<RabbitQueueInfo[]> {
    const response = await this.request<{ queues?: RabbitQueueInfo[] }>('/admin/rabbitmq/queues')
    return Array.isArray(response?.queues) ? response.queues : []
  }

  async queueMessages(queue: string, session = '', limit = 20): Promise<RabbitQueueMessage[]> {
    const query = new URLSearchParams({ limit: `${limit}` })
    if (session) query.set('session', session)
    const response = await this.request<{ messages?: RabbitQueueMessage[] }>(`/admin/rabbitmq/queues/${encodeURIComponent(queue)}/messages?${query}`)
    return Array.isArray(response?.messages) ? response.messages : []
  }

  purgeQueue(queue: string, count: number | 'all'): Promise<{ removed: number | 'all' }> {
    return this.request<{ removed: number | 'all' }>(`/admin/rabbitmq/queues/${encodeURIComponent(queue)}/messages`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: queue, count }),
    })
  }

  async redisKeys(search = '', limit = 500): Promise<string[]> {
    const query = new URLSearchParams({ limit: `${limit}` })
    if (search.trim()) query.set('search', search.trim())
    const response = await this.request<{ keys?: string[] }>(`/admin/redis/keys?${query}`)
    return Array.isArray(response?.keys) ? response.keys : []
  }

  async redisTree(prefix = '', limit = 100): Promise<RedisTreeNode[]> {
    const query = new URLSearchParams({ limit: `${limit}` })
    if (prefix) query.set('prefix', prefix)
    const response = await this.request<{ nodes?: RedisTreeNode[] }>(`/admin/redis/tree?${query}`)
    return Array.isArray(response?.nodes) ? response.nodes : []
  }

  deleteRedisPrefix(prefix: string): Promise<{ removed: number }> {
    const query = new URLSearchParams({ prefix })
    return this.request<{ removed: number }>(`/admin/redis/tree?${query}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: prefix }),
    })
  }

  redisKey(key: string): Promise<RedisKeyDetails> {
    return this.request<RedisKeyDetails>(`/admin/redis/keys/${encodeURIComponent(key)}`)
  }

  saveRedisKey(key: string, type: RedisKeyType, value: unknown, ttlSeconds: number): Promise<void> {
    return this.request<void>(`/admin/redis/keys/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ confirm: key, type, value, ttlSeconds }),
    })
  }

  deleteRedisKey(key: string): Promise<{ removed: number }> {
    return this.request<{ removed: number }>(`/admin/redis/keys/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: key }),
    })
  }

  async redisQuery(command: string, args: string[]): Promise<unknown> {
    const response = await this.request<{ result?: unknown }>('/admin/redis/query', {
      method: 'POST',
      body: JSON.stringify({ command, args }),
    })
    return response?.result
  }

  voipBootstrap(): Promise<VoipBootstrap> {
    return this.request<VoipBootstrap>('/admin/voip/bootstrap')
  }

  voipStartCall(session: string, peerJid: string, extensionId: string): Promise<{ session: string; callId: string }> {
    return this.request('/admin/voip/calls', { method: 'POST', body: JSON.stringify({ session, peerJid, extensionId }) })
  }

  voipCommand(
    session: string,
    callId: string,
    command: 'accept' | 'reject' | 'end' | 'mute',
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.request(`/admin/voip/calls/${encodeURIComponent(callId)}/${command}`, {
      method: 'POST',
      body: JSON.stringify({ session, ...payload }),
    })
  }

  voipConsole(path: string, method = 'GET', payload?: unknown): Promise<any> {
    return this.request(`/admin/voip/console/${path.replace(/^\/+/, '')}`, {
      method,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  }

  voipHistory(options: VoipHistoryQuery = {}): Promise<VoipHistoryPage> {
    const query = new URLSearchParams()
    if (options.page) query.set('page', `${options.page}`)
    if (options.pageSize) query.set('pageSize', `${options.pageSize}`)
    if (options.search?.trim()) query.set('search', options.search.trim())
    if (options.startDate?.trim()) query.set('startDate', options.startDate.trim())
    if (options.endDate?.trim()) query.set('endDate', options.endDate.trim())
    const encodedQuery = query.toString()
    const suffix = encodedQuery ? `?${encodedQuery}` : ''
    return this.request<VoipHistoryPage>(`/admin/voip/console/history${suffix}`)
  }

  voipUploadTransferAudio(extensionGroupId: string, file: File): Promise<any> {
    return this.request(`/admin/voip/console/extensionGroups/${encodeURIComponent(extensionGroupId)}/transfer-audio`, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
  }

  async voipTransferAudio(extensionGroupId: string): Promise<Blob> {
    const headers = new Headers()
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await this.fetcher.call(globalThis, `${this.baseUrl}/admin/voip/console/extensionGroups/${encodeURIComponent(extensionGroupId)}/transfer-audio`, { headers })
    if (!response.ok) {
      const text = await response.text()
      let payload: unknown = text
      try { payload = text ? JSON.parse(text) : undefined } catch {}
      throw new ApiError(response.status, errorMessage(payload, response.status), payload)
    }
    return response.blob()
  }

  voipTransfer(callId: string, targetExtensionId: string): Promise<any> {
    return this.voipConsole(`calls/${encodeURIComponent(callId)}/transfer`, 'POST', { targetExtensionId })
  }

  async voipRecording(recordId: string): Promise<Blob> {
    const headers = new Headers()
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await this.fetcher.call(globalThis, `${this.baseUrl}/admin/voip/recordings/${encodeURIComponent(recordId)}`, { headers })
    if (!response.ok) {
      const text = await response.text()
      let payload: unknown = text
      try { payload = text ? JSON.parse(text) : undefined } catch {}
      throw new ApiError(response.status, errorMessage(payload, response.status), payload)
    }
    return response.blob()
  }
}
