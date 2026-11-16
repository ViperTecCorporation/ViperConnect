import { Readable } from 'node:stream'
import { LogLineDecoder, dockerLogLines, journalLogLines, sanitizedLog, matchesLog } from '../../src/services/service_control/log_parser'
import { logOptions, logQuery } from '../../src/services/service_control/log_types'

const collect = async <T>(source: AsyncIterable<T>) => { const values: T[] = []; for await (const value of source) values.push(value); return values }
const frame = (channel: number, text: string) => { const payload = Buffer.from(text), header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(payload.length, 4); return Buffer.concat([header, payload]) }
test('strict bounded literal filters serialize and reject regex-like option injection, invalid channels and unbounded history', () => {
  const options = logOptions({ tail: '2000', include: 'error,áudio', level: 'warn', channel: 'stderr' })
  expect(logQuery(options)).toContain('tail=2000')
  for (const query of [{ tail: 'all' }, { tail: '2001' }, { include: ['x'] }, { include: 'x'.repeat(201) }, { include: 'a,b,c,d,e,f,g,h,i' }, { target: 'other' }, { level: '--unit=ssh' }, { channel: 'stdin' }, { since: '1' }, { include: 'a\nb' }]) expect(() => logOptions(query as any)).toThrow('logs_query_invalid')
  expect(logOptions({ since: String(Math.floor(Date.now() / 1000) - 1) }).since).toBeGreaterThan(0)
})
test('UTF8, interleaved Docker stdout/stderr, fragmented headers and TTY are decoded without mixing partial lines', async () => {
  const bytes = Buffer.concat([frame(1, '2026-11-16T09:00:00.123456789Z áu'), frame(2, '2026-11-16T09:00:01Z falha\n'), frame(1, 'dio 🎧\nresto')])
  const pieces = Array.from(bytes, byte => Buffer.from([byte]))
  const lines = await collect(dockerLogLines(Readable.from(pieces), false))
  expect(lines.map(line => line.text)).toEqual(['2026-11-16T09:00:01Z falha', '2026-11-16T09:00:00.123456789Z áudio 🎧', 'resto'])
  expect(lines.map(line => line.channel)).toEqual(['stderr', 'stdout', 'stdout'])
  expect((await collect(dockerLogLines(Readable.from([Buffer.from('plain\n')]), true)))[0].text).toBe('plain')
  await expect(collect(dockerLogLines(Readable.from([Buffer.from('bad')]), false))).rejects.toThrow('logs_format_invalid')
  const invalid = Buffer.alloc(8); invalid[0] = 3
  await expect(collect(dockerLogLines(Readable.from([invalid]), false))).rejects.toThrow('logs_format_invalid')
})
test('oversized lines are omitted completely, including secrets cut across chunk boundaries', () => {
  const decoder = new LogLineDecoder()
  const out = [...decoder.feed(Buffer.from('authorization: Bear'), 'stdout'), ...decoder.feed(Buffer.from('er PRIVATE\n' + 'x'.repeat(33000)), 'stdout'), ...decoder.feed(Buffer.from('PASSWORD\nend'), 'stdout'), ...decoder.finish()]
  expect(sanitizedLog(out[0]).text).not.toContain('PRIVATE')
  expect(out[1]).toMatchObject({ omitted: true }); expect(out[1].text).not.toContain('PASSWORD')
  expect(out[2].text).toBe('end')
})
test('journal preserves time, byte messages and per-entry identities while refusing malformed JSON', async () => {
  const raw = JSON.stringify({ MESSAGE: 'uma\nduas', PRIORITY: '3', __REALTIME_TIMESTAMP: '1794819600123456', __CURSOR: 'cursor' }) + '\n'
  const lines = await collect(journalLogLines(Readable.from([Buffer.from(raw)])))
  expect(lines).toHaveLength(2); expect(sanitizedLog(lines[0]).level).toBe('error'); expect(sanitizedLog(lines[0]).id).not.toBe(sanitizedLog(lines[1]).id)
  expect(lines[0].timestamp).toBe('2026-11-16T09:00:00.123Z')
  const binary = JSON.stringify({ MESSAGE: [111, 105], __REALTIME_TIMESTAMP: '1794819600123456' }) + '\n'
  expect((await collect(journalLogLines(Readable.from([Buffer.from(binary)]))))[0].text).toBe('oi')
  await expect(collect(journalLogLines(Readable.from([Buffer.from('not json\n')])))).rejects.toThrow('logs_format_invalid')
})
test('redaction precedes literal case-insensitive filters and does not pretend unknown levels are info', () => {
  const line = sanitizedLog({ text: '2026-11-16T09:00:00.123456789Z {"level":50,"password":"PRIVATE","headers":{"Authorization":"Bearer ABC"},"msg":"áudio ERRO <script>"}', channel: 'stdout' })
  expect(line.text).not.toMatch(/PRIVATE|Bearer ABC/); expect(line.level).toBe('error'); expect(line.timestamp).toBe('2026-11-16T09:00:00.123456789Z')
  expect(matchesLog(line, logOptions({ include: 'erro,missing', exclude: 'ignored', level: 'warn' }))).toBe(true)
  expect(matchesLog(line, logOptions({ exclude: 'áudio' }))).toBe(false)
  expect(matchesLog(line, logOptions({ include: 'PRIVATE' }))).toBe(false)
  expect(matchesLog(line, logOptions({ channel: 'stderr' }))).toBe(false)
  expect(sanitizedLog({ text: 'Authorization: Basic PRIVATE redis://user:pass@host \x1b[31mKEY', channel: 'stderr' }, ['KEY_PRIVATE']).text).not.toMatch(/PRIVATE|user:pass|\x1b/)
  const unknown = sanitizedLog({ text: 'unstructured', channel: 'stdout' })
  expect(matchesLog(unknown, logOptions({ level: 'info' }))).toBe(false)
  expect(sanitizedLog({ text: 'KEY_PRIVATE', channel: 'stdout' }, ['KEY_PRIVATE']).text).toBe('[REDACTED]')
  expect(sanitizedLog({ text: '{"storage":{"secretAccessKey":"AWS_PRIVATE","accessKeyId":"KEY_PRIVATE"},"cookie":"session=PRIVATE"}', channel: 'stdout' }).text).not.toMatch(/AWS_PRIVATE|KEY_PRIVATE|session=PRIVATE/)
  expect(sanitizedLog({ text: 'STORAGE_SECRET_ACCESS_KEY=AWS_PRIVATE', channel: 'stdout' }).text).not.toContain('AWS_PRIVATE')
})
