import { Readable } from 'node:stream'
import { VoipBackups } from '../../src/services/voip_backups'
import * as defaults from '../../src/defaults'

const payload = Buffer.from('synthetic-voip-private-archive')
const setup = () => {
  const values = new Map<string, string>(), blobs = new Map<string, Buffer>(), json = new Map<string, any>()
  const redis = { get: jest.fn(async (key: string) => values.get(key) || null), set: jest.fn(async (key: string, value: string, options?: any) => { if (options?.NX && values.has(key)) return null; values.set(key, value); return 'OK' }), del: jest.fn(async (key: string) => values.delete(key)), eval: jest.fn(async () => 1), scan: jest.fn(async () => ({ cursor: 0, keys: [] })) }
  const objects = { save: jest.fn(async (key: string, stream: any) => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); blobs.set(key, Buffer.concat(parts)) }), open: jest.fn(async (key: string) => Readable.from([blobs.get(key)!])), json: jest.fn(async (key: string) => json.has(key) ? { value: json.get(key), etag: 'synthetic-etag' } : undefined), putJson: jest.fn(async (key: string, value: any) => { json.set(key, value); return true }), remove: jest.fn(async () => {}), keys: async function* () {} }
  const service = { available: () => true, request: jest.fn(async (path: string, init?: any): Promise<any> => {
    if (path.endsWith('/capability')) return { available: true, restoring: false }
    if (path.endsWith('/restore')) { for await (const _ of init.body) { /* Consume uploaded bytes without effects. */ }; return { restored: true, recordingsRestored: false } }
    throw new Error('unexpected_request')
  }), stream: jest.fn(async () => new Response(payload)) }
  const lease = { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn(async () => {}) }
  return { backup: new VoipBackups(service as any, { redis, objects, lease }), redis, objects, service, lease, values, blobs, json }
}
beforeEach(() => jest.spyOn(defaults, 'STORAGE_OPTIONS').mockReturnValue({ bucket: 'synthetic-private' } as any))
afterEach(() => jest.restoreAllMocks())

test('S3 backup verifies readable bytes/hash, publishes weekly sidecar and exposes no archive contents in status', async () => {
  const f = setup(), manifest = await f.backup.backup()
  expect(manifest.uploadVerified).toBe(true); expect(manifest.recordingsIncluded).toBe(false)
  expect(manifest.objectKey).toMatch(/^backups\/voip\/voip-main\/.+\.vipervoip$/)
  expect(f.objects.open).toHaveBeenCalledWith(manifest.objectKey)
  const state = await f.backup.status(); expect(state.files).toHaveLength(1)
  expect(JSON.stringify(state)).not.toContain(payload.toString())
  const downloaded = await f.backup.download(manifest.id), parts: Buffer[] = []
  for await (const c of downloaded.stream) parts.push(Buffer.from(c))
  expect(Buffer.concat(parts)).toEqual(payload)
})

test('corrupt uploads or a lost lease never publish a ready backup', async () => {
  const f = setup(); f.objects.open.mockResolvedValueOnce(Readable.from(['corrupt']))
  await expect(f.backup.backup()).rejects.toThrow('verification_failed'); expect(f.objects.putJson).not.toHaveBeenCalled()
  f.lease.renew.mockResolvedValue(false)
  await expect(f.backup.backup()).rejects.toThrow('lease_lost'); expect(f.objects.putJson).not.toHaveBeenCalled()
})

test('restore creates/retains a verified pre-change backup and posts only once; network ambiguity blocks automatic retry', async () => {
  const f = setup(), manifest = await f.backup.backup(), restored = await f.backup.restore(manifest.id)
  expect(restored.restored).toBe(true); expect(restored.beforeBackupId).not.toBe(manifest.id)
  const requests = f.service.request.mock.calls.filter(([path]) => path.endsWith('/restore'))
  expect(requests).toHaveLength(1); expect(requests[0][1].headers['X-Voip-Restore-Operation']).toMatch(/^[a-f0-9-]{36}$/)
  const original = f.service.request.getMockImplementation()!
  f.service.request.mockImplementation(async (path: string, init?: any) => { if (path.endsWith('/restore')) throw new Error('network_timeout'); return original(path, init) })
  await expect(f.backup.restore(manifest.id)).rejects.toThrow('network_timeout')
  const postsBefore = f.service.request.mock.calls.filter(([path]) => path.endsWith('/restore')).length
  await expect(f.backup.restore(manifest.id)).rejects.toThrow('pending_confirmation')
  expect(f.service.request.mock.calls.filter(([path]) => path.endsWith('/restore'))).toHaveLength(postsBefore)
  await f.backup.backup()
  expect((await f.backup.status()).state.phase).toBe('restore_unconfirmed')
})

test('same 12-hour window is claimed once across shared workers', async () => {
  const f = setup(); await f.backup.scheduled(); await f.backup.scheduled()
  expect(f.service.stream).toHaveBeenCalledTimes(1)
})
