import { createHash, timingSafeEqual } from 'node:crypto'
import { ServiceControlError } from './types'

export function controlAuthorized(actual: unknown, token: string) {
  return token.length >= 32 && typeof actual === 'string'
    && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(`Bearer ${token}`).digest())
}

/** Operator-configured endpoints only; never redirects, URL credentials or browser-supplied URLs. */
export function controlUrl(raw: string) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ServiceControlError(503, 'control_config_invalid')
  return url
}

export async function controlJson(url: URL, token: string, init: RequestInit = {}, fetcher: typeof fetch = fetch, timeout = 8000) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers,
    } })
    const chunks: Uint8Array[] = []; let size = 0
    if (response.body) for await (const part of response.body as any) {
      size += part.length
      if (size > 128 * 1024) { await response.body.cancel().catch(() => undefined); throw new Error('limit') }
      chunks.push(part)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (!response.ok) throw new ServiceControlError([400, 403, 404, 409, 423].includes(response.status) ? response.status : 503,
      typeof value.error === 'string' && /^control_[a-z_]+$/.test(value.error) ? value.error : 'control_unavailable')
    return value
  } catch (error) {
    if (error instanceof ServiceControlError) throw error
    throw new ServiceControlError(503, 'control_unavailable')
  }
}
