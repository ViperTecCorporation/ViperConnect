import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { backupArchiveReadable, BACKUP_STREAM_HIGH_WATER_MARK, decodeBackupStream, encodeBackupStream } from '../../src/services/session_storage/backup_stream'
import { encryptSessionStream } from '../../src/services/session_transfer/archive_stream'

const password = 'synthetic-legacy-backup-key'
const meta = { kind: 'test', configuration: { autoConnect: false }, binary: 'not-secret' }
const records = [{ offset: 0, data: 'AP8=' }, { offset: 2, data: 'AQ==' }]
const source = async function* (values: unknown[] = records) { yield* values }
async function collect(stream: AsyncIterable<Buffer>) { const result: Buffer[] = []; for await (const chunk of stream) result.push(chunk); return Buffer.concat(result) }
async function decoded(input: Buffer | string, key?: string) { const result: any[] = []; for await (const frame of decodeBackupStream(Readable.from([input]), key)) result.push(frame); return result }
async function archive() { return collect(encodeBackupStream(meta, source())) }

test('archive read-ahead is byte-bounded under a slow consumer, without changing wire bytes', async () => {
  const chunks = async function* () { for (let n = 0; n < 128; n++) yield Buffer.alloc(128 * 1024, n) }
  const stream = backupArchiveReadable(chunks())
  expect(stream.readableObjectMode).toBe(false)
  expect(stream.readableHighWaterMark).toBe(BACKUP_STREAM_HIGH_WATER_MARK)
  let bytes = 0, queued = 0
  await pipeline(stream, new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    bytes += chunk.length
    setImmediate(() => { queued = Math.max(queued, stream.readableLength); done() })
  } }))
  expect(bytes).toBe(16 * 1024 * 1024)
  expect(queued).toBeLessThanOrEqual(BACKUP_STREAM_HIGH_WATER_MARK + 128 * 1024)
  expect(await collect(backupArchiveReadable(encodeBackupStream(meta, source())))).toEqual(await archive())
})

test('consumer failure closes the archive iterator instead of continuing to prefetch a backup', async () => {
  let closed = false, produced = 0
  const chunks = async function* () {
    try { for (let n = 0; n < 1000; n++) { produced++; yield Buffer.alloc(128 * 1024) } }
    finally { closed = true }
  }
  const stream = backupArchiveReadable(chunks())
  await expect(pipeline(stream, new Writable({ write(_chunk, _encoding, done) { done(new Error('synthetic upload interrupted')) } })))
    .rejects.toThrow('synthetic upload interrupted')
  expect(stream.destroyed).toBe(true)
  expect(closed).toBe(true)
  expect(produced).toBeLessThan(10)
})
function rewrite(input: Buffer, mutate: (lines: any[]) => void, repair = false) {
  const frames = input.toString().trimEnd().split('\n').map(line => JSON.parse(line)); mutate(frames)
  if (repair && frames[frames.length - 1].kind === 'end') frames[frames.length - 1].sha256 = createHash('sha256').update(frames.slice(0, -1).map(frame => JSON.stringify(frame) + '\n').join('')).digest('hex')
  return frames.map(frame => JSON.stringify(frame) + '\n').join('')
}

test('plain JSONL roundtrip is explicit, versioned, unencrypted and readable without a key', async () => {
  const bytes = await archive(), frames = await decoded(bytes)
  expect(JSON.parse(bytes.toString().split('\n')[0])).toEqual({ format: 'viperconnect-storage-backup-stream', version: 1, protection: 'none' })
  expect(bytes.toString()).toContain('not-secret'); expect(bytes.toString()).not.toContain('salt')
  expect(frames).toEqual([{ kind: 'meta', value: meta, protection: 'none' }, { kind: 'records', value: records }, { kind: 'end', count: 2 }])
  expect(await decoded(bytes, 'irrelevant short value')).toEqual(frames)
})

test('arbitrary one-byte transport boundaries preserve frames and footer', async () => {
  const input = await archive(), result: any[] = []
  for await (const frame of decodeBackupStream(Readable.from([...input].map(byte => Buffer.from([byte]))))) result.push(frame)
  expect(result).toEqual(await decoded(input))
})

test('batches are bounded to one hundred records and an empty backup still requires metadata and footer', async () => {
  const result = await decoded(await collect(encodeBackupStream(meta, source(Array.from({ length: 251 }, (_, n) => ({ n }))))))
  expect(result.filter(frame => frame.kind === 'records').map(frame => frame.value.length)).toEqual([100, 100, 51])
  expect(result[result.length - 1]).toEqual({ kind: 'end', count: 251 })
  expect(await decoded(await collect(encodeBackupStream(meta, source([]))))).toEqual([{ kind: 'meta', value: meta, protection: 'none' }, { kind: 'end', count: 0 }])
})

test.each([
  ['version', (frames: any[]) => { frames[0].version = 2 }],
  ['unknown format', (frames: any[]) => { frames[0].format = 'foreign' }],
  ['protection', (frames: any[]) => { frames[0].protection = 'aes-256-gcm' }],
  ['unknown header field', (frames: any[]) => { frames[0].extra = true }],
  ['record before metadata', (frames: any[]) => { frames[1].kind = 'records' }],
  ['duplicate metadata', (frames: any[]) => { frames[2].kind = 'meta' }],
  ['index jump', (frames: any[]) => { frames[2].index = 7 }],
  ['unknown frame field', (frames: any[]) => { frames[1].extra = true }],
  ['empty records', (frames: any[]) => { frames[2].value = [] }],
  ['overfull records', (frames: any[]) => { frames[2].value = Array(101).fill({}) }],
  ['footer count', (frames: any[]) => { frames[3].count = 1 }],
  ['footer index', (frames: any[]) => { frames[3].index = 5 }],
  ['missing metadata', (frames: any[]) => { frames.splice(1, 2); frames[1].index = 0; frames[1].count = 0 }],
  ['unknown footer field', (frames: any[]) => { frames[3].extra = true }],
])('rejects %s even with recalculated unkeyed checksum', async (_name, mutate) => {
  await expect(decoded(rewrite(await archive(), mutate, true))).rejects.toThrow('session_storage_backup_stream_invalid')
})

test('footer detects valid-JSON metadata/configuration or record corruption, not only binary-data hash changes', async () => {
  const original = await archive()
  await expect(decoded(rewrite(original, frames => { frames[1].value.configuration.autoConnect = true }))).rejects.toThrow('session_storage_backup_stream_invalid')
  await expect(decoded(rewrite(original, frames => { frames[2].value[0].data = 'AQE=' }))).rejects.toThrow('session_storage_backup_stream_invalid')
  await expect(decoded(rewrite(original, frames => { frames[3].sha256 = 'a'.repeat(64) }))).rejects.toThrow('session_storage_backup_stream_invalid')
})

test('rejects truncation, absent terminal newline/footer, trailing frames, empty lines and malformed JSON', async () => {
  const original = await archive(), lines = original.toString().trimEnd().split('\n')
  for (const value of [original.subarray(0, original.length - 1), lines.slice(0, -1).join('\n') + '\n', original.toString() + lines[1] + '\n', original.toString() + '\n', 'bad-json\n', '']) await expect(decoded(value)).rejects.toThrow('session_storage_backup_stream_invalid')
})

test('bounds encoded frames, parsed lines, headers and invalid UTF-8', async () => {
  await expect(collect(encodeBackupStream(meta, source(['x'.repeat(4 * 1024 * 1024)])))).rejects.toThrow('session_storage_backup_record_too_large')
  await expect(decoded(Buffer.concat([Buffer.alloc(6 * 1024 * 1024 + 1, 120), Buffer.from('\n')]))).rejects.toThrow('session_storage_backup_stream_invalid')
  await expect(decoded(' '.repeat(2049) + '{}\n')).rejects.toThrow('session_storage_backup_stream_invalid')
  await expect(decoded(Buffer.from([255, 10]))).rejects.toThrow('session_storage_backup_stream_invalid')
})

test('detects legacy authenticated archive, requires its key explicitly, and preserves encrypted manual-transfer codec', async () => {
  const legacy = await collect(encryptSessionStream(meta, source(), password))
  expect(legacy.toString()).not.toContain('not-secret')
  expect(await decoded(legacy, password)).toEqual([{ kind: 'meta', value: meta, protection: 'aes-256-gcm' }, { kind: 'records', value: records }, { kind: 'end', count: 2 }])
  await expect(decoded(legacy)).rejects.toMatchObject({ code: 'session_storage_backup_legacy_key_required' })
  await expect(decoded(legacy, 'another-valid-wrong-password')).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
  const damaged = Buffer.from(legacy); damaged[damaged.length - 20] ^= 1
  await expect(decoded(damaged, password)).rejects.toThrow('mobile_backup_invalid_or_wrong_password')
})
