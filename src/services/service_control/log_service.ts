import { once } from 'node:events'
import type { Response } from 'express'
import { ControlTarget, ServiceControlError } from './types'
import { LogEvent, LogOptions } from './log_types'
import { HostLogSources, LogHandle, LogSources } from './log_sources'
import { matchesLog, sanitizedLog } from './log_parser'

export async function writeLogEvent(response: Response, event: LogEvent, signal: AbortSignal) {
  if (signal.aborted || response.destroyed) throw new ServiceControlError(503, 'logs_closed')
  if (!response.write(JSON.stringify(event) + '\n')) await once(response, 'drain', { signal })
}

/** No Redis/S3 persistence. Four viewers maximum, with bounded lifetime and raw input budget. */
export class ServiceLogService {
  private active = 0
  private controllers = new Set<AbortController>()
  constructor(private readonly targets: ControlTarget[], private readonly sources: LogSources = new HostLogSources(), private readonly secrets: string[] = [], private readonly duration = 300000, private readonly inputLimit = 8 * 1024 * 1024) {}
  async stream(component: string, options: LogOptions, response: Response) {
    const target = this.targets.find(target => target.component === component)
    if (!target) throw new ServiceControlError(404, 'logs_target_not_allowed')
    if (this.active >= 4) throw new ServiceControlError(429, 'logs_viewers_limit')
    this.active++
    const abort = new AbortController(), disconnected = () => abort.abort()
    this.controllers.add(abort)
    response.once('close', disconnected)
    let handle: LogHandle | undefined, heartbeat: NodeJS.Timeout | undefined, timedOut = false
    const deadline = setTimeout(() => { timedOut = true; abort.abort() }, this.duration); deadline.unref()
    try {
      handle = await this.sources.open(target, options, abort.signal)
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders()
      await writeLogEvent(response, { type: 'connected', name: target.name, backend: target.backend }, abort.signal)
      heartbeat = setInterval(() => { if (!response.writableNeedDrain && !abort.signal.aborted) response.write('{"type":"heartbeat"}\n') }, 10000); heartbeat.unref()
      let bytes = 0, count = 0
      for await (const raw of handle.lines) {
        bytes += Buffer.byteLength(raw.text); count++
        if (bytes > this.inputLimit || count > 50000) { await writeLogEvent(response, { type: 'end', reason: 'input_limit' }, abort.signal); return }
        const line = sanitizedLog(raw, this.secrets)
        if (matchesLog(line, options)) await writeLogEvent(response, { type: 'line', line }, abort.signal)
      }
      if (timedOut && !response.destroyed) response.write('{"type":"end","reason":"time_limit"}\n')
      else if (!abort.signal.aborted) await writeLogEvent(response, { type: 'end', reason: 'source_closed' }, abort.signal)
    } catch (error) {
      if (!response.headersSent) throw error instanceof ServiceControlError ? error : new ServiceControlError(503, 'logs_source_unavailable')
      if (!response.destroyed) response.write(JSON.stringify(timedOut ? { type: 'end', reason: 'time_limit' } : error instanceof ServiceControlError && error.code === 'logs_input_limit' ? { type: 'end', reason: 'input_limit' } : { type: 'error', error: 'logs_source_unavailable' }) + '\n')
    } finally {
      clearTimeout(deadline); clearInterval(heartbeat); response.removeListener('close', disconnected)
      abort.abort(); handle?.close(); this.active--; this.controllers.delete(abort)
      if (response.headersSent && !response.destroyed) response.end()
    }
  }
  closeAll() { for (const controller of this.controllers) controller.abort() }
}
