import { once } from 'node:events'
import type { Response } from 'express'
import { ServiceControlClient } from './client'
import { LogOptions } from './log_types'
import { ServiceControlError } from './types'

export class ServiceLogProxy {
  private active = 0
  constructor(private readonly client = new ServiceControlClient()) {}
  async stream(component: string, options: LogOptions, response: Response) {
    if (this.active >= 4) throw new ServiceControlError(429, 'logs_viewers_limit')
    this.active++
    const abort = new AbortController(), close = () => abort.abort()
    response.once('close', close)
    const deadline = setTimeout(close, 330000); deadline.unref()
    let body: ReadableStream<Uint8Array> | null | undefined
    try {
      const upstream = await this.client.logs(component, options, abort.signal); body = upstream.body
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Accel-Buffering', 'no'); response.flushHeaders()
      let bytes = 0
      for await (const chunk of body as any) {
        bytes += chunk.length
        if (bytes > 32 * 1024 * 1024) throw new ServiceControlError(503, 'logs_input_limit')
        if (!response.write(chunk)) await once(response, 'drain', { signal: abort.signal })
      }
    } catch (error) {
      if (!response.headersSent) throw error instanceof ServiceControlError ? error : new ServiceControlError(503, 'logs_source_unavailable')
      if (!response.destroyed) response.write('{"type":"error","error":"logs_source_unavailable"}\n')
    } finally {
      abort.abort(); await body?.cancel().catch(() => undefined)
      clearTimeout(deadline); response.removeListener('close', close); this.active--
      if (response.headersSent && !response.destroyed) response.end()
    }
  }
}
