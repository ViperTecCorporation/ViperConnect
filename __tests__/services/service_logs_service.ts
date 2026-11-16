import { EventEmitter } from 'node:events'
import { ServiceLogService, writeLogEvent } from '../../src/services/service_control/log_service'
import { ServiceLogProxy } from '../../src/services/service_control/log_proxy'
import { logOptions } from '../../src/services/service_control/log_types'

class Output extends EventEmitter {
  destroyed = false; headersSent = false; writableNeedDrain = false; records: string[] = []; ended = false
  setHeader = jest.fn(); flushHeaders() { this.headersSent = true }
  write(value: any) { this.records.push(typeof value === 'string' ? value : Buffer.from(value).toString()); return true }
  end() { this.ended = true }
}
const target = { component: 'a'.repeat(24), name: 'worker', backend: 'docker' as const, target: 'fixed-worker' }
test('redacted filtered NDJSON streams incrementally and always closes its source', async () => {
  const close = jest.fn(), sources = { open: jest.fn().mockResolvedValue({ close, lines: (async function* () { yield { text: '{"level":30,"msg":"ignore"}', channel: 'stdout' }; yield { text: '{"level":50,"password":"PRIVATE","msg":"audio"}', channel: 'stderr' } })() }) }
  const service = new ServiceLogService([target], sources as any), output = new Output()
  await service.stream(target.component, logOptions({ include: 'audio', level: 'error' }), output as any)
  expect(output.records.join('')).not.toContain('PRIVATE'); expect(output.records.join('')).not.toContain('ignore')
  expect(output.records.join('')).toContain('REDACTED'); expect(close).toHaveBeenCalled(); expect(output.ended).toBe(true)
  expect(output.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no')
})
test('viewer and time limits, server shutdown and disconnect free every reader', async () => {
  const closes = jest.fn(), sources = { open: jest.fn(async (_target, _options, signal: AbortSignal) => ({ close: closes, lines: (async function* () {
    yield { text: 'begin', channel: 'stdout' }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    if (signal.aborted) throw new Error('aborted')
  })() })) }
  const service = new ServiceLogService([target], sources as any), outputs = Array.from({ length: 4 }, () => new Output())
  const pending = outputs.map(output => service.stream(target.component, logOptions({}), output as any))
  await expect(service.stream(target.component, logOptions({}), new Output() as any)).rejects.toThrow('logs_viewers_limit')
  await new Promise(resolve => setTimeout(resolve, 5)); service.closeAll(); await Promise.all(pending)
  expect(closes).toHaveBeenCalledTimes(4)
  const timed = new ServiceLogService([target], sources as any, [], 10), output = new Output()
  await timed.stream(target.component, logOptions({}), output as any)
  expect(output.records.join('')).toContain('time_limit')
  await expect(service.stream('b'.repeat(24), logOptions({}), new Output() as any)).rejects.toThrow('logs_target_not_allowed')
})
test('backpressure waits for drain and abort can release a slow reader', async () => {
  const output = new Output(); output.write = jest.fn(() => false)
  const abort = new AbortController(), pending = writeLogEvent(output as any, { type: 'heartbeat' }, abort.signal)
  output.emit('drain'); await pending
  const blocked = writeLogEvent(output as any, { type: 'heartbeat' }, abort.signal)
  abort.abort(); await expect(blocked).rejects.toThrow()
})
test('a source ending gracefully on deadline still emits an explicit time-limit event', async () => {
  const sources = { open: async (_target: any, _options: any, signal: AbortSignal) => ({ close: jest.fn(), lines: (async function* () {
    yield { text: 'begin', channel: 'stdout' }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })() }) }
  const output = new Output(), service = new ServiceLogService([target], sources as any, [], 10)
  await service.stream(target.component, logOptions({}), output as any)
  expect(output.records.join('')).toContain('time_limit'); expect(output.ended).toBe(true)
})
test('web proxy streams without buffering a full file and passes disconnect to the upstream', async () => {
  const client = { logs: jest.fn().mockResolvedValue(new Response('{"type":"heartbeat"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } })) }
  const proxy = new ServiceLogProxy(client as any), output = new Output()
  await proxy.stream(target.component, logOptions({}), output as any)
  expect(output.records.join('')).toBe('{"type":"heartbeat"}\n'); expect(output.ended).toBe(true)
  expect(client.logs.mock.calls[0][2].aborted).toBe(true)
})
