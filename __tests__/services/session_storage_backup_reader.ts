import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { readSqliteBackupArchive, SQLITE_BACKUP_CHUNK_BYTES } from '../../src/services/session_storage/backup_reader'
import { encodeBackupStream } from '../../src/services/session_storage/backup_stream'
import type { SqliteBackupManifest } from '../../src/services/session_storage/backup'

function fixture(data = Buffer.from('synthetic snapshot bytes')) {
  const id = randomUUID(), phone = '999123456789'
  const expected: SqliteBackupManifest = { id, version: 1, phone, storageId: randomUUID(), generation: 2,
    createdAt: '2026-11-16T00:00:00Z', objectKey: `backups/session-storage/${phone}/${id}.viperstorage`,
    bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), kind: 'linked-session', status: 'ready', protection: 'none' }
  const meta: any = { kind: 'sqlite-session', version: 1, manifest: expected, supplement: { binaryIdentityFixture: 'preserved' } }
  const records: any[] = [{ offset: 0, data: data.toString('base64') }]
  let source: Readable
  const objects = { open: jest.fn(async () => source = Readable.from(encodeBackupStream(meta, (async function* () { yield* records })()))) }
  return { data, expected, meta, records, objects, source: () => source }
}

test('readback checks the entire downloaded image and supplement without allocating a restore file', async () => {
  const f = fixture()
  expect(await readSqliteBackupArchive(f.objects, f.expected)).toEqual(f.meta.supplement)
  expect(f.objects.open).toHaveBeenCalledWith(f.expected.objectKey)
  expect(f.source().destroyed).toBe(true)
})

test('restore sink is sequential and bounded to one decoded chunk, with backpressure', async () => {
  const f = fixture(Buffer.alloc(SQLITE_BACKUP_CHUNK_BYTES * 4, 0xab))
  f.records.splice(0, 1, ...Array.from({ length: 4 }, (_, i) => ({ offset: i * SQLITE_BACKUP_CHUNK_BYTES,
    data: f.data.subarray(i * SQLITE_BACKUP_CHUNK_BYTES, (i + 1) * SQLITE_BACKUP_CHUNK_BYTES).toString('base64') })))
  let inFlight = 0, peak = 0, length = 0
  const hash = createHash('sha256')
  await readSqliteBackupArchive(f.objects, f.expected, undefined, async chunk => {
    inFlight++; peak = Math.max(peak, inFlight); expect(chunk.length).toBeLessThanOrEqual(SQLITE_BACKUP_CHUNK_BYTES)
    await new Promise(resolve => setImmediate(resolve)); hash.update(chunk); length += chunk.length; inFlight--
  })
  expect(peak).toBe(1); expect(length).toBe(f.expected.bytes); expect(hash.digest('hex')).toBe(f.expected.sha256)
})

test.each(['offset', 'base64', 'empty', 'extra-property', 'too-large', 'wrong-bytes', 'wrong-hash', 'wrong-content'])(
  'rejects %s even when the archive footer is freshly recomputed', async change => {
    const f = fixture()
    if (change === 'offset') f.records[0].offset++
    if (change === 'base64') f.records[0].data += '!'
    if (change === 'empty') f.records[0].data = ''
    if (change === 'extra-property') f.records[0].untrusted = true
    if (change === 'too-large') f.records[0].data = Buffer.alloc(SQLITE_BACKUP_CHUNK_BYTES + 1).toString('base64')
    if (change === 'wrong-bytes') f.expected.bytes++
    if (change === 'wrong-hash') f.expected.sha256 = '0'.repeat(64)
    if (change === 'wrong-content') f.records[0].data = Buffer.alloc(f.data.length, 0xff).toString('base64')
    await expect(readSqliteBackupArchive(f.objects, f.expected)).rejects.toThrow('session_storage_backup_invalid')
    expect(f.source().destroyed).toBe(true)
  })

test.each(['kind', 'version', 'manifest', 'supplement', 'protection'])(
  'rejects altered metadata %s and never trusts the remote manifest over the local digest', async field => {
    const f = fixture()
    if (field === 'kind') f.meta.kind = 'different'
    if (field === 'version') f.meta.version = 2
    if (field === 'manifest') f.meta.manifest = { ...f.expected, sha256: '0'.repeat(64) }
    if (field === 'supplement') f.meta.supplement = []
    if (field === 'protection') f.expected.protection = 'aes-256-gcm'
    await expect(readSqliteBackupArchive(f.objects, f.expected)).rejects.toThrow('session_storage_backup_invalid')
  })

test('mobile primary registration remains mandatory for readback and restore', async () => {
  const f = fixture(); f.expected.kind = 'mobile-primary'
  await expect(readSqliteBackupArchive(f.objects, f.expected)).rejects.toThrow('session_storage_mobile_registration_required')
  f.meta.supplement.registration = { synthetic: true }
  await expect(readSqliteBackupArchive(f.objects, f.expected)).resolves.toEqual(f.meta.supplement)
})

test('rejects a missing footer and closes the upstream on a destination failure', async () => {
  const f = fixture(), buffers: Buffer[] = []
  for await (const chunk of encodeBackupStream(f.meta, (async function* () { yield* f.records })())) buffers.push(chunk)
  await expect(readSqliteBackupArchive({ open: async () => Readable.from(buffers.slice(0, -1)) }, f.expected)).rejects.toThrow('session_storage_backup_stream_invalid')
  const failure = new Error('synthetic destination failure')
  await expect(readSqliteBackupArchive(f.objects, f.expected, undefined, async () => { throw failure })).rejects.toBe(failure)
  expect(f.source().destroyed).toBe(true)
})
