import { VoipService, VoipServiceError } from './voip_service'

const SCOPE_HEADER = 'X-Unoapi-Session-Scope'
const APPLIED_HEADER = 'X-Unoapi-Session-Scope-Applied'
const FIELDS = ['id', 'callId', 'phoneNumber', 'direction', 'status', 'accountLabel',
  'extensionId', 'extensionUsername', 'extensionLabel', 'remoteNumber', 'remoteName', 'remoteNameSource', 'remoteJid',
  'startedAt', 'answeredAt', 'endedAt', 'durationSeconds', 'endReason',
  'recordingStatus', 'recordingMime', 'recordingSizeBytes', 'recordingDurationSeconds',
  'aiSummaryStatus', 'aiTranscriptText', 'aiSummaryText']
const deny = (): never => { throw new VoipServiceError(403, 'manager_voip_forbidden') }

/** Versioned trusted-service contract; never infer scoping from an empty page. */
export class ManagerVoipHistory {
  private readonly phones: string[]

  constructor(private readonly service: VoipService, phones: ReadonlySet<string>) {
    this.phones = [...phones].filter(phone => /^[0-9]{8,15}$/.test(phone)).sort()
  }

  static supported(state: any): boolean {
    return state?.capabilities?.managerSessionHistoryScope === 1
  }

  private async requireSupport() {
    if (!ManagerVoipHistory.supported(await this.service.request('/v1/console/bootstrap'))) deny()
  }

  private headers() { return { [SCOPE_HEADER]: JSON.stringify(this.phones) } }

  async history(query: Record<string, unknown> = {}) {
    const params = new URLSearchParams()
    for (const name of ['page', 'pageSize', 'limit', 'search', 'startDate', 'endDate']) {
      const value = query[name]
      if (value === undefined) continue
      if (typeof value !== 'string') deny()
      params.set(name, value as string)
    }
    if (!this.phones.length) {
      const positive = (value: string | null, fallback: number) => value && /^[1-9][0-9]*$/.test(value)
        && Number.isSafeInteger(Number(value)) ? Number(value) : fallback
      return { items: [], total: 0, page: positive(params.get('page'), 1),
        pageSize: Math.min(100, positive(params.get('limit') || params.get('pageSize'), 20)),
        totalPages: 1, scope: { version: 1, phones: [] } }
    }
    await this.requireSupport()
    const suffix = params.size ? `?${params.toString()}` : ''
    const result = await this.service.request<any>(`/v1/console/history${suffix}`, { headers: this.headers() })
    const echoed = result?.scope?.phones
    if (result?.scope?.version !== 1 || !Array.isArray(echoed)
      || echoed.length !== this.phones.length || new Set(echoed).size !== echoed.length
      || !echoed.every(phone => typeof phone === 'string' && this.phones.includes(phone))
      || !Array.isArray(result?.items)) deny()
    // Reject the whole response: filtering an already paginated global result
    // would disclose global counts and silently produce incorrect pagination.
    if (!result.items.every((item: any) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.id === 'string' && !!item.id
      && typeof item.phoneNumber === 'string' && this.phones.includes(item.phoneNumber))) deny()
    for (const name of ['total', 'page', 'pageSize', 'totalPages']) {
      if (!Number.isSafeInteger(result[name]) || result[name] < (name === 'total' ? 0 : 1)) deny()
    }
    if (result.pageSize > 100 || result.items.length > result.pageSize || result.items.length > result.total
      || result.totalPages !== Math.max(1, Math.ceil(result.total / result.pageSize))
      || (!this.phones.length && result.total !== 0)) deny()
    return {
      items: result.items.map((item: Record<string, unknown>) => Object.fromEntries(FIELDS
        .filter(key => ['string', 'number', 'boolean'].includes(typeof item[key])).map(key => [key, item[key]]))),
      total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages,
      ...Object.fromEntries(['search', 'startDate', 'endDate'].filter(key => typeof result[key] === 'string').map(key => [key, result[key]])),
      scope: { version: 1, phones: this.phones },
    }
  }

  async recording(id: string) {
    if (!this.phones.length || typeof id !== 'string' || id.length > 1024
      || !/^[a-zA-Z0-9_:@.-]+$/.test(id) || id === '.' || id === '..') deny()
    await this.requireSupport()
    const response = await this.service.stream(`/v1/console/history-records/${encodeURIComponent(id)}/recording`, { headers: this.headers() })
    if (!response.ok || response.headers.get(APPLIED_HEADER) !== '1') {
      try { await response.body?.cancel() } catch { /* Still deny; never stream unverified bytes. */ }
      deny()
    }
    return response
  }
}
