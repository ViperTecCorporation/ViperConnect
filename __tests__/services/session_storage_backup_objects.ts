const mockSend = jest.fn(), mockUploadDone = jest.fn(), mockUpload = jest.fn(), mockClient = jest.fn(), mockHandler = jest.fn()
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(readonly input: unknown) {} }
  return { S3Client: class { constructor(options: unknown) { mockClient(options) }; send = mockSend },
    GetObjectCommand: class extends Command {}, PutObjectCommand: class extends Command {}, DeleteObjectCommand: class extends Command {}, ListObjectsV2Command: class extends Command {} }
})
jest.mock('@aws-sdk/lib-storage', () => ({ Upload: class { constructor(options: unknown) { mockUpload(options) }; done = mockUploadDone } }))
jest.mock('@smithy/node-http-handler', () => ({ NodeHttpHandler: class { constructor(options: unknown) { mockHandler(options) } } }))
jest.mock('../../src/defaults', () => ({ STORAGE_OPTIONS: jest.fn(() => ({ bucket: 'synthetic-private-backups' })) }))
import { Readable } from 'node:stream'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createBackupObjects } from '../../src/services/session_storage/backup_objects'

const id = '12345678-1234-4234-8234-123456789abc', phone = '999123456789', base = `backups/session-storage/${phone}/`, archive = `${base}${id}.viperstorage`, pointer = `${base}slots/0.json`
beforeEach(() => { jest.clearAllMocks(); mockSend.mockReset(); mockUploadDone.mockReset(); mockUploadDone.mockResolvedValue(undefined) })

test('backup upload is isolated from media deletion queues and uses a bounded SDK Upload without real credentials or network', async () => {
  const objects = createBackupObjects(), source = Readable.from([Buffer.from('synthetic encrypted bytes')])
  await objects.save(archive, source)
  expect(mockClient).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'synthetic-private-backups', maxAttempts: 3 }))
  expect(mockClient.mock.calls[0][0]).not.toHaveProperty('credentials')
  expect(mockUpload).toHaveBeenCalledWith(expect.objectContaining({ params: { Bucket: 'synthetic-private-backups', Key: archive, Body: source, ContentType: 'application/octet-stream' }, queueSize: 1, partSize: 5 * 1024 * 1024 }))
  expect(mockUploadDone).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled()
  mockUploadDone.mockRejectedValueOnce(Error('upload-failed')); await expect(objects.save(archive, Readable.from([]))).rejects.toThrow('upload-failed')
})

test('open returns only a Node readable, normalizes missing-object errors and never hides other SDK failures', async () => {
  const objects = createBackupObjects(), stream = Readable.from([Buffer.from('encrypted')])
  mockSend.mockResolvedValueOnce({ Body: stream }); expect(await objects.open(archive)).toBe(stream)
  expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand)
  mockSend.mockResolvedValueOnce({ Body: {} }); await expect(objects.open(archive)).rejects.toThrow('object_unavailable')
  for (const error of [{ name: 'NoSuchKey' }, { name: 'NotFound' }, { $metadata: { httpStatusCode: 404 } }]) { mockSend.mockRejectedValueOnce(error); await expect(objects.open(archive)).rejects.toThrow('backup_not_found') }
  mockSend.mockRejectedValueOnce(Error('sdk-unavailable')); await expect(objects.open(archive)).rejects.toThrow('sdk-unavailable')
})

test('JSON pointers are bounded, require ETag and destroy malformed/oversized streams instead of using a fallback', async () => {
  const objects = createBackupObjects(), date = new Date('2026-11-08T16:00:00Z')
  mockSend.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('{"verified":true}')]), ETag: '"etag"', LastModified: date })
  expect(await objects.json(pointer)).toEqual({ value: { verified: true }, etag: '"etag"', modifiedAt: date.getTime() })
  mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' }); expect(await objects.json(pointer)).toBeUndefined()
  mockSend.mockResolvedValueOnce({ Body: Readable.from([]) }); await expect(objects.json(pointer)).rejects.toThrow('pointer_unavailable')
  const corrupt = Readable.from([Buffer.from('invalid-json')]); mockSend.mockResolvedValueOnce({ Body: corrupt, ETag: 'one' })
  await expect(objects.json(pointer)).rejects.toThrow(); expect(corrupt.destroyed).toBe(true)
  const oversized = Readable.from([Buffer.alloc(16385)]); mockSend.mockResolvedValueOnce({ Body: oversized, ETag: 'two' })
  await expect(objects.json(pointer)).rejects.toThrow('pointer_invalid'); expect(oversized.destroyed).toBe(true)
})

test('pointer writes use create-only or exact ETag CAS; conflicts are false, transport failures stay explicit', async () => {
  const objects = createBackupObjects(); mockSend.mockResolvedValue({})
  expect(await objects.putJson(pointer, { ready: true }, null)).toBe(true)
  expect(mockSend.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand)
  expect(mockSend.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: '*', Body: '{"ready":true}', ContentType: 'application/json' })
  expect(mockSend.mock.calls[0][1]).toHaveProperty('abortSignal')
  expect(await objects.putJson(pointer, { ready: true }, '"prior"')).toBe(true)
  expect(mockSend.mock.calls[1][0].input).toMatchObject({ IfMatch: '"prior"' }); expect(mockSend.mock.calls[1][0].input).not.toHaveProperty('IfNoneMatch')
  for (const status of [409, 412]) { mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: status } }); expect(await objects.putJson(pointer, {}, 'old')).toBe(false) }
  mockSend.mockRejectedValueOnce(Error('transport-ambiguous')); await expect(objects.putJson(pointer, {}, 'old')).rejects.toThrow('transport-ambiguous')
  const before = mockSend.mock.calls.length; await expect(objects.putJson(pointer, { large: 'x'.repeat(16385) }, null)).rejects.toThrow('pointer_invalid'); expect(mockSend).toHaveBeenCalledTimes(before)
})

test('scope validation rejects media, traversal, invalid UUID/slots/prefix before any SDK call', async () => {
  const objects = createBackupObjects()
  for (const key of [`${phone}/media/video.mp4`, '../session.sqlite', `${base}slots/7.json`, `${base}bad.viperstorage`, `${base}${id}.viperstorage/other`]) {
    await expect(objects.save(key, Readable.from([]))).rejects.toThrow('scope_invalid')
    await expect(objects.open(key)).rejects.toThrow('scope_invalid')
    await expect(objects.remove(key)).rejects.toThrow('scope_invalid')
    await expect(objects.json(key)).rejects.toThrow('scope_invalid')
    await expect(objects.putJson(key, {}, null)).rejects.toThrow('scope_invalid')
  }
  await expect(async () => { for await (const _key of objects.keys(base.slice(0, -1))) void _key }).rejects.toThrow('scope_invalid')
  expect(mockSend).not.toHaveBeenCalled(); expect(mockUpload).not.toHaveBeenCalled()
})

test('listing is paged at 100 keys and excludes arbitrary media/nonbackup names; removal uses only the requested backup object', async () => {
  const objects = createBackupObjects(), sidecar = archive + '.manifest.json'
  mockSend.mockResolvedValueOnce({ Contents: [{ Key: archive }, { Key: `${base}media.jpg` },
    { Key: `backups/session-storage/999987654321/${id}.viperstorage` }, { Key: `backups/redis/synthetic-stack/${id}.rdb.viperbackup` }], IsTruncated: true, NextContinuationToken: 'page-two' })
    .mockResolvedValueOnce({ Contents: [{ Key: sidecar }, { Key: pointer }], IsTruncated: false })
  const keys: string[] = []; for await (const key of objects.keys(base)) keys.push(key)
  expect(keys).toEqual([archive, sidecar, pointer]); expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command)
  expect(mockSend.mock.calls[0][0].input).toMatchObject({ Prefix: base, MaxKeys: 100 })
  expect(mockSend.mock.calls[1][0].input).toMatchObject({ ContinuationToken: 'page-two' })
  mockSend.mockResolvedValueOnce({}); await objects.remove(archive)
  expect(mockSend.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand); expect(mockSend.mock.calls[2][0].input.Key).toBe(archive)
})
