import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostLogSources, dockerLogResponse, limitedLogChunks } from '../../src/services/service_control/log_sources'
import { logOptions } from '../../src/services/service_control/log_types'

test('Docker log source binds exact inspected ID and closes the HTTP stream on disconnect', async () => {
  const response = Readable.from([Buffer.from('hello\n')]), inspect = jest.fn().mockResolvedValue({ reference: 'f'.repeat(64), tty: true }), open = jest.fn().mockResolvedValue(response)
  const sources = new HostLogSources({ inspect } as any, open), abort = new AbortController()
  const handle = await sources.open({ component: 'a'.repeat(24), name: 'test', backend: 'docker', target: 'allowed' }, logOptions({ tail: '100' }), abort.signal)
  expect(open.mock.calls[0][0]).toBe(`/containers/${'f'.repeat(64)}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=100&since=0`)
  const lines = []; for await (const line of handle.lines) lines.push(line)
  handle.close(); expect(response.destroyed).toBe(true); expect(lines[0].text).toBe('hello')
})
test('native journalctl invocation is fixed and cancelling a viewer kills only its own child process', async () => {
  let child: ReturnType<typeof spawn> | undefined
  const launch = jest.fn((() => {
    child = spawn(process.execPath, ['-e', 'console.log(JSON.stringify({MESSAGE:"native test",PRIORITY:"6",__REALTIME_TIMESTAMP:"1794819600123456"}));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},500)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return child
  }) as any)
  const abort = new AbortController(), sources = new HostLogSources(undefined, undefined, launch as any)
  const handle = await sources.open({ component: 'a'.repeat(24), name: 'native', backend: 'systemd', target: 'viper-worker.service' }, logOptions({ tail: '100' }), abort.signal)
  expect(launch.mock.calls[0][0]).toBe('/usr/bin/journalctl')
  expect(launch.mock.calls[0][1]).toEqual(['--unit', 'viper-worker.service', '--output=json', '--no-pager', '--follow', '--lines', '100'])
  const iterator = handle.lines[Symbol.asyncIterator](); expect((await iterator.next()).value.text).toBe('native test')
  const closed = new Promise<void>(resolve => child!.once('close', () => resolve()))
  abort.abort(); await closed; await iterator.return?.()
  expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true)
})
test('socket connection errors and raw byte budgets are explicit, not empty successful logs', async () => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\viper-log-${randomUUID()}` : join(tmpdir(), `viper-log-${randomUUID()}.sock`)
  const server = createServer((_req, res) => res.writeHead(503).end('private failure'))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  try { await expect(dockerLogResponse('/logs', new AbortController().signal, socket)).rejects.toThrow('logs_source_unavailable') }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  const input = limitedLogChunks(Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)]), new AbortController().signal)
  await expect(input.next()).rejects.toThrow('logs_input_limit')
})
