import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import { redactLogString, redactLogValue } from '../log_redaction'
import { LogChannel, LogOptions, RawLogLine, ServiceLogLine } from './log_types'
import { ServiceControlError } from './types'

/** Keeps only a partial UTF-8 line per channel. Oversized lines are omitted, never partly disclosed. */
export class LogLineDecoder {
  private states = new Map<LogChannel, { decoder: StringDecoder; partial: string; omitted: boolean }>();
  *feed(data: Buffer, channel: LogChannel): Generator<RawLogLine> {
    const state = this.states.get(channel) || { decoder: new StringDecoder('utf8'), partial: '', omitted: false }
    this.states.set(channel, state)
    const value = state.decoder.write(data)
    let offset = 0
    while (offset < value.length) {
      const end = value.indexOf('\n', offset), part = value.slice(offset, end < 0 ? value.length : end)
      if (!state.omitted) {
        if (state.partial.length + part.length > 32768) { state.partial = ''; state.omitted = true }
        else state.partial += part
      }
      if (end < 0) break
      yield { text: state.omitted ? '[log line omitted: size limit]' : state.partial.replace(/\r$/, ''), channel, omitted: state.omitted || undefined }
      state.partial = ''; state.omitted = false; offset = end + 1
    }
  }
  *finish(): Generator<RawLogLine> {
    for (const [channel, state] of this.states) {
      const text = state.partial + state.decoder.end()
      if (text || state.omitted) yield { text: state.omitted ? '[log line omitted: size limit]' : text, channel, omitted: state.omitted || undefined }
    }
    this.states.clear()
  }
}

export async function* dockerLogLines(chunks: AsyncIterable<Buffer>, tty: boolean): AsyncGenerator<RawLogLine> {
  const lines = new LogLineDecoder(); let header = Buffer.alloc(0), remaining = 0, channel: LogChannel = 'stdout'
  for await (const data of chunks) {
    if (tty) { yield* lines.feed(data, 'stdout'); continue }
    let offset = 0
    while (offset < data.length) {
      if (!remaining) {
        const amount = Math.min(8 - header.length, data.length - offset)
        header = Buffer.concat([header, data.subarray(offset, offset + amount)]); offset += amount
        if (header.length !== 8) continue
        if (![1, 2].includes(header[0]) || header[1] || header[2] || header[3]) throw new ServiceControlError(503, 'logs_format_invalid')
        remaining = header.readUInt32BE(4); channel = header[0] === 2 ? 'stderr' : 'stdout'; header = Buffer.alloc(0)
        if (remaining > 1024 * 1024) throw new ServiceControlError(503, 'logs_format_invalid')
        if (!remaining) continue
      }
      const amount = Math.min(remaining, data.length - offset)
      yield* lines.feed(data.subarray(offset, offset + amount), channel); remaining -= amount; offset += amount
    }
  }
  if (remaining || header.length) throw new ServiceControlError(503, 'logs_format_invalid')
  yield* lines.finish()
}

export async function* journalLogLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<RawLogLine> {
  const decoder = new LogLineDecoder()
  const entry = function* (line: RawLogLine): Generator<RawLogLine> {
    if (line.omitted) { yield line; return }
    let value: any
    try { value = JSON.parse(line.text) } catch { throw new ServiceControlError(503, 'logs_format_invalid') }
    const message = typeof value.MESSAGE === 'string' ? value.MESSAGE : Array.isArray(value.MESSAGE) && value.MESSAGE.length <= 32768 && value.MESSAGE.every(v => Number.isInteger(v) && v >= 0 && v <= 255) ? Buffer.from(value.MESSAGE).toString('utf8') : '[journal message omitted]'
    const milliseconds = /^\d{1,16}$/.test(value.__REALTIME_TIMESTAMP || '') ? Math.floor(Number(value.__REALTIME_TIMESTAMP) / 1000) : undefined
    const timestamp = milliseconds && Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
    for (const [index, text] of message.split('\n').entries()) yield { text, channel: 'journal', timestamp, identity: `${value.__CURSOR || value.__REALTIME_TIMESTAMP || ''}:${index}:${value.PRIORITY || ''}` }
  }
  for await (const chunk of chunks) for (const line of decoder.feed(chunk, 'journal')) yield* entry(line)
  for (const line of decoder.finish()) yield* entry(line)
}

export function sanitizedLog(raw: RawLogLine, secrets: string[] = []): ServiceLogLine {
  let text = raw.text, timestamp = raw.timestamp
  const prefix = text.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) /)
  if (prefix && Number.isFinite(Date.parse(prefix[1]))) { timestamp = prefix[1]; text = text.slice(prefix[0].length) }
  text = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  let parsed: any, level: string | undefined
  try { parsed = JSON.parse(text); text = JSON.stringify(redactLogValue(parsed), (key, value) => /(?:password|passwd|secret|token|authorization|api.?key|credential|access.?key|cookies?)/i.test(key) ? '[REDACTED]' : value) } catch { /* Plain log line. */ }
  const levels = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
  level = levels[parsed?.level] || (typeof parsed?.level === 'string' ? parsed.level.toLowerCase() : undefined)
  if (level === 'warning') level = 'warn'
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(level || '')) level = undefined
  const priority = raw.identity?.split(':').at(-1) || ''
  if (!level && raw.channel === 'journal' && /^[0-7]$/.test(priority)) level = ['fatal', 'fatal', 'fatal', 'error', 'warn', 'info', 'info', 'debug'][Number(priority)]
  if (!level) level = text.match(/\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i)?.[1].toLowerCase().replace('warning', 'warn')
  text = text.replace(/(\bauthorization\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s,;"']+/gi, '$1"[REDACTED]"')
    .replace(/(["']?[\w-]*(?:password|passwd|secret|token|authorization|api[_-]?key|credential|access[_-]?key|cookie)[\w-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[REDACTED]"')
  text = redactLogString(text.replace(/(\bauthorization\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s,;"']+/gi, '$1[REDACTED]')).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[REDACTED]')
  const id = createHash('sha256').update(`${raw.channel}:${timestamp || ''}:${raw.identity || ''}:${text}`).digest('hex').slice(0, 24)
  return { id, text, channel: raw.channel, timestamp, level, omitted: raw.omitted }
}

export function matchesLog(line: ServiceLogLine, options: LogOptions) {
  const rank = { trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6 }
  if (options.channel !== 'all' && line.channel !== options.channel || options.level !== 'all' && !(rank[line.level || ''] >= rank[options.level])) return false
  const text = line.text.toLocaleLowerCase(), terms = (value: string) => value.toLocaleLowerCase().split(',').map(term => term.trim()).filter(Boolean)
  const include = terms(options.include)
  return (!include.length || include.some(term => text.includes(term))) && !terms(options.exclude).some(term => text.includes(term))
}
