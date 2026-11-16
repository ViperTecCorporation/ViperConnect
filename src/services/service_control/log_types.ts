import { ServiceControlError } from './types'

export const LOG_LEVELS = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export type LogChannel = 'stdout' | 'stderr' | 'journal'
export interface LogOptions { tail: number; include: string; exclude: string; level: LogLevel; channel: 'all' | LogChannel; since: number }
export interface RawLogLine { text: string; channel: LogChannel; timestamp?: string; identity?: string; omitted?: boolean }
export interface ServiceLogLine extends RawLogLine { id: string; level?: string }
export type LogEvent = { type: 'connected'; name: string; backend: string } | { type: 'line'; line: ServiceLogLine }
  | { type: 'heartbeat' } | { type: 'end'; reason: string } | { type: 'error'; error: string }

export function logOptions(query: Record<string, unknown>, now = Date.now()): LogOptions {
  if (Object.keys(query).some(key => !['tail', 'include', 'exclude', 'level', 'channel', 'since'].includes(key))) throw new ServiceControlError(400, 'logs_query_invalid')
  const scalar = (key: string, fallback: string) => {
    const value = query[key] ?? fallback
    if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new ServiceControlError(400, 'logs_query_invalid')
    return value.trim()
  }
  const tail = scalar('tail', '300'), since = scalar('since', '0'), level = scalar('level', 'all'), channel = scalar('channel', 'all')
  if (!/^\d{1,4}$/.test(tail) || Number(tail) < 1 || Number(tail) > 2000 || !/^\d{1,12}$/.test(since)
    || !LOG_LEVELS.includes(level as LogLevel) || !['all', 'stdout', 'stderr', 'journal'].includes(channel)
    || Number(since) && (Number(since) < Math.floor(now / 1000) - 86400 || Number(since) > Math.floor(now / 1000) + 60)) throw new ServiceControlError(400, 'logs_query_invalid')
  const include = scalar('include', ''), exclude = scalar('exclude', '')
  if ([include, exclude].some(value => value.split(',').length > 8)) throw new ServiceControlError(400, 'logs_query_invalid')
  return { tail: Number(tail), since: Number(since), include, exclude, level: level as LogLevel, channel: channel as LogOptions['channel'] }
}

export function logQuery(options: LogOptions) { return new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])).toString() }
