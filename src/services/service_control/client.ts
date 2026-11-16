import { controlJson, controlUrl } from './http'
import { ControlOverview, RestartOperation, RestartRequest, ServiceControlError } from './types'
import { LogOptions, logQuery } from './log_types'

/** Web proxy has no Docker socket, systemctl privileges or caller-selected management URL. */
export class ServiceControlClient {
  constructor(private readonly url = process.env.SERVICE_CONTROL_URL || '', private readonly token = process.env.SERVICE_CONTROL_TOKEN || '', private readonly fetcher: typeof fetch = fetch) {}
  private request(path: string, body?: unknown) {
    if (!this.url || this.token.length < 32) throw new ServiceControlError(503, 'control_not_configured')
    const base = controlUrl(this.url)
    return controlJson(new URL(path, base), this.token, body ? { method: 'POST', body: JSON.stringify(body) } : {}, this.fetcher)
  }
  async overview(): Promise<ControlOverview> {
    if (!this.url || this.token.length < 32) return { configured: false, targets: [], reason: 'control_not_configured' }
    return this.request('/v1/targets')
  }
  async restart(component: string, body: RestartRequest, actor: string): Promise<RestartOperation> { return this.request(`/v1/targets/${component}/restart`, { ...body, actor }) }
  async operation(id: string): Promise<RestartOperation> { return this.request(`/v1/operations/${id}`) }
  async logs(component: string, options: LogOptions, signal: AbortSignal): Promise<Response> {
    if (!this.url || this.token.length < 32) throw new ServiceControlError(503, 'logs_not_configured')
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 8000)
    try {
      const response = await this.fetcher(new URL(`/v1/targets/${component}/logs?${logQuery(options)}`, controlUrl(this.url)), {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/x-ndjson' }, signal: AbortSignal.any([signal, deadline.signal]), redirect: 'error',
      })
      if (!response.ok) {
        let text = ''
        if (response.body) {
          const reader = response.body.getReader()
          try { const chunk = await reader.read(); text = Buffer.from(chunk.value || []).subarray(0, 4096).toString() } finally { await reader.cancel().catch(() => undefined) }
        }
        let code = 'logs_source_unavailable'
        try { const value = JSON.parse(text); if (/^logs_[a-z_]+$/.test(value.error)) code = value.error } catch { /* Never expose upstream bodies. */ }
        throw new ServiceControlError([400, 403, 404, 429].includes(response.status) ? response.status : 503, code)
      }
      if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) { await response.body?.cancel(); throw new ServiceControlError(503, 'logs_format_invalid') }
      return response
    } catch (error) { throw error instanceof ServiceControlError ? error : new ServiceControlError(503, 'logs_source_unavailable') }
    finally { clearTimeout(timer) }
  }
}
