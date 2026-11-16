import { request, IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { ControlTarget, ServiceControlError } from './types'
import { DockerControlDriver } from './drivers'
import { LogOptions, RawLogLine } from './log_types'
import { dockerLogLines, journalLogLines } from './log_parser'

export interface LogHandle { lines: AsyncIterable<RawLogLine>; close(): void }
export interface LogSources { open(target: ControlTarget, options: LogOptions, signal: AbortSignal): Promise<LogHandle> }

export async function* limitedLogChunks(chunks: AsyncIterable<Buffer>, signal: AbortSignal) {
  let bytes = 0
  for await (const chunk of chunks) {
    if (signal.aborted) return
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw new ServiceControlError(413, 'logs_input_limit')
    yield chunk
  }
}

export function dockerLogResponse(path: string, signal: AbortSignal, socketPath = '/var/run/docker.sock'): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, signal, timeout: 4000 }, res => {
      req.setTimeout(0)
      if (res.statusCode !== 200) { res.destroy(); reject(new ServiceControlError(503, 'logs_source_unavailable')); return }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => reject(new ServiceControlError(503, 'logs_source_unavailable'))); req.end()
  })
}

export class HostLogSources implements LogSources {
  constructor(private readonly docker = new DockerControlDriver(), private readonly response = dockerLogResponse, private readonly launch = spawn) {}
  async open(target: ControlTarget, options: LogOptions, signal: AbortSignal): Promise<LogHandle> {
    if (target.backend === 'docker') {
      const instance = await this.docker.inspect(target)
      const query = new URLSearchParams({ stdout: '1', stderr: '1', timestamps: '1', follow: '1', tail: String(options.tail), since: String(options.since) })
      const response = await this.response(`/containers/${instance.reference}/logs?${query}`, signal)
      return { lines: dockerLogLines(limitedLogChunks(response, signal), instance.tty === true), close: () => response.destroy() }
    }
    const args = ['--unit', target.target, '--output=json', '--no-pager', '--follow', '--lines', String(options.tail)]
    if (options.since) args.push(`--since=@${options.since}`)
    const child = this.launch('/usr/bin/journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    let closed = false, failed = false
    const exit = new Promise<number | null>(resolve => { child.once('close', code => { closed = true; resolve(code) }) })
    // Discard stderr, which can contain private host paths; expose only explicit sanitized errors.
    child.stderr?.resume(); child.once('error', () => { failed = true })
    const close = () => {
      if (closed) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, 1000); timer.unref()
      child.once('close', () => clearTimeout(timer))
    }
    signal.addEventListener('abort', close, { once: true })
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new ServiceControlError(503, 'logs_source_unavailable'))) })
    } catch (error) { signal.removeEventListener('abort', close); close(); throw error }
    const lines = async function* () {
      try {
        if (!child.stdout) throw new ServiceControlError(503, 'logs_source_unavailable')
        yield* journalLogLines(limitedLogChunks(child.stdout, signal))
        const code = await exit
        if (!signal.aborted && (failed || code !== 0)) throw new ServiceControlError(503, 'logs_source_unavailable')
      } finally { signal.removeEventListener('abort', close); close() }
    }
    return { lines: lines(), close }
  }
}
