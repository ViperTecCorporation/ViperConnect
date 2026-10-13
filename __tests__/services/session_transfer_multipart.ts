import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { MultipartSessionRestore, RESTORE_PART_BYTES } from '../../src/services/session_transfer/multipart_restore'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fixture = () => {
  const data = new Map<string, string>(), objects = new Map<string, Buffer>()
  const redis = { get: jest.fn(async key => data.get(key) || null), eval: jest.fn(async (script: string, { keys, arguments: args }: any) => {
    if (script.includes("'EX',86400")) { data.set(keys[0], args[0]); return 1 }
    if (script.includes("'EXISTS',KEYS[1])==1")) { if (data.has(keys[0])) return 0; data.set(keys[0], args[0]); return 1 }
    if (script.includes("'PEXPIRE'")) return data.get(keys[0]) === args[0] ? 1 : 0
    if (script.includes("'GET',KEYS[2]")) {
      if (data.get(keys[1]) !== args[0] || !data.has(keys[0])) return 0
      data.set(keys[0], args[1]); if (keys[2]) data.set(keys[2], args[2]); return 1
    }
    if (script.includes("'GET',KEYS[1]")) { if (data.get(keys[0]) !== args[0]) return 0; data.delete(keys[0]); return 1 }
    data.delete(keys[0]); return 1
  }) }
  const storage: any = {
    saveMediaStream: jest.fn(async (key, stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); objects.set(key, Buffer.concat(chunks)); return true }),
    downloadMediaStream: jest.fn(async key => objects.has(key) ? Readable.from([objects.get(key)]) : undefined),
    removeMedia: jest.fn(async key => { objects.delete(key) }),
  }
  const restore = jest.fn(async source => { let bytes = 0; for await (const chunk of source) bytes += chunk.length; return { restored: true, bytes } })
  const scheduleRemoval = jest.fn(async () => {})
  const service = new MultipartSessionRestore({ redis, storage: async () => storage, restore, scheduleRemoval })
  return { service, redis, data, objects, storage, restore, scheduleRemoval }
}
const awaitTerminal = async (service: MultipartSessionRestore, id: string) => {
  for (let i = 0; i < 100; i++) { await new Promise(setImmediate); const state = await service.status('admin', id); if (state.state !== 'restoring') return state }
  throw new Error('restore did not complete')
}
const confirmation = { password: 'synthetic-password', confirmOriginOffline: true }

test('multipart accepts bounded ordered parts, verifies hashes, restores in background and cleans encrypted storage', async () => {
  const s = fixture(), first = Buffer.alloc(RESTORE_PART_BYTES, 7), last = Buffer.from('tail')
  const upload = await s.service.start('admin', { size: first.length + last.length })
  expect(upload.partSize).toBe(RESTORE_PART_BYTES)
  await s.service.part('admin', upload.id, 0, sha(first), Readable.from([first]))
  await expect(s.service.complete('admin', upload.id, confirmation)).rejects.toThrow('session_upload_incomplete')
  await s.service.part('admin', upload.id, 0, sha(first), Readable.from([first]))
  expect(s.storage.saveMediaStream).toHaveBeenCalledTimes(1)
  await s.service.part('admin', upload.id, 1, sha(last), Readable.from([last]))
  expect(s.restore).not.toHaveBeenCalled()
  expect(await s.service.complete('admin', upload.id, confirmation)).toMatchObject({ state: 'restoring' })
  const result = await awaitTerminal(s.service, upload.id)
  expect(result.state).toBe('ready'); expect((result.result as any).bytes).toBe(first.length + last.length + Buffer.byteLength(JSON.stringify(confirmation) + '\n'))
  await new Promise(setImmediate)
  expect(s.objects.size).toBe(0); expect(s.scheduleRemoval).toHaveBeenCalledTimes(2)
  await s.service.complete('admin', upload.id, confirmation)
  expect(s.restore).toHaveBeenCalledTimes(1)
  expect(JSON.stringify([...s.data.values()])).not.toContain('synthetic-password')
})

test('invalid sizes, IDs, owners, expiry, order, checksum and overlong parts never reach restoration', async () => {
  const s = fixture()
  for (const body of [{ size: 0 }, { size: -1 }, { size: 1.5 }, { size: 5, password: 'secret' }]) await expect(s.service.start('admin', body)).rejects.toThrow('session_upload_invalid')
  await expect(s.service.status('admin', '../file')).rejects.toThrow('session_upload_invalid')
  const upload = await s.service.start('admin', { size: 5 }), bytes = Buffer.from('12345')
  await expect(s.service.status('other-admin', upload.id)).rejects.toThrow('session_upload_not_found')
  await expect(s.service.part('admin', upload.id, 1, sha(bytes), Readable.from([bytes]))).rejects.toThrow('session_upload_part_order')
  await expect(s.service.part('admin', upload.id, -1, sha(bytes), Readable.from([bytes]))).rejects.toThrow('session_upload_part_invalid')
  await expect(s.service.part('admin', upload.id, 0, '0'.repeat(64), Readable.from([bytes]))).rejects.toThrow('session_upload_part_checksum')
  await expect(s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([Buffer.alloc(6)]))).rejects.toThrow('session_upload_part_too_large')
  await expect(s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([Buffer.alloc(4)]))).rejects.toThrow('session_upload_part_checksum')
  await expect(s.service.complete('admin', upload.id, { password: 'synthetic-password', confirmOriginOffline: false })).rejects.toThrow()
  const key = [...s.data.keys()].find(k => k.endsWith(upload.id))!, meta = JSON.parse(s.data.get(key)!); meta.expiresAt = 1; s.data.set(key, JSON.stringify(meta))
  await expect(s.service.status('admin', upload.id)).rejects.toThrow('session_upload_expired')
  expect(s.restore).not.toHaveBeenCalled(); expect(s.objects.size).toBe(0)
})

test('cancellation, part conflicts and missing or corrupted stored parts are handled without applying credentials', async () => {
  for (const scenario of ['cancel', 'corrupt', 'missing']) {
    const s = fixture(), bytes = Buffer.from('12345'), upload = await s.service.start('admin', { size: bytes.length })
    await s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([bytes]))
    await expect(s.service.part('admin', upload.id, 0, sha(Buffer.from('54321')), Readable.from(['54321']))).rejects.toThrow('session_upload_part_conflict')
    if (scenario === 'cancel') { expect(await s.service.cancel('admin', upload.id)).toEqual({ cancelled: true }); expect(s.objects.size).toBe(0); continue }
    const key = [...s.objects.keys()][0]
    if (scenario === 'missing') s.objects.delete(key); else s.objects.set(key, Buffer.from('54321'))
    await s.service.complete('admin', upload.id, confirmation)
    expect((await awaitTerminal(s.service, upload.id)).state).toBe('failed')
    expect(s.objects.size).toBe(0)
  }
})

test('a lost restore process is reported as interrupted, never resumed or cancelled automatically', async () => {
  const s = fixture(), upload = await s.service.start('admin', { size: 5 })
  const key = [...s.data.keys()].find(k => k.endsWith(upload.id))!, meta = JSON.parse(s.data.get(key)!); meta.state = 'restoring'; s.data.set(key, JSON.stringify(meta))
  expect(await s.service.status('admin', upload.id)).toMatchObject({ state: 'interrupted', error: 'session_restore_interrupted' })
  await expect(s.service.cancel('admin', upload.id)).rejects.toThrow('session_upload_busy')
  await s.service.complete('admin', upload.id, confirmation)
  expect(s.restore).not.toHaveBeenCalled()
})

test('storage failure leaves the part uncommitted and concurrent mutation is rejected', async () => {
  const s = fixture(), upload = await s.service.start('admin', { size: 5 }), bytes = Buffer.from('12345')
  s.storage.saveMediaStream.mockResolvedValueOnce(false)
  await expect(s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([bytes]))).rejects.toThrow('session_upload_storage_failed')
  expect((await s.service.status('admin', upload.id)).received).toBe(0)
  s.data.set([...s.data.keys()][0] + ':lock', 'foreign-owner')
  await expect(s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([bytes]))).rejects.toThrow('session_upload_busy')
})

test('lost lease never commits a receipt and task results never expose raw exceptions or passwords', async () => {
  const s = fixture(), upload = await s.service.start('admin', { size: 5 }), bytes = Buffer.from('12345')
  const original = s.redis.eval.getMockImplementation()!
  s.redis.eval.mockImplementation(async (script: string, options: any) => script.includes("'PEXPIRE'") ? 0 : original(script, options))
  await expect(s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([bytes]))).rejects.toThrow('session_upload_lease_lost')
  expect((await s.service.status('admin', upload.id)).received).toBe(0)
  expect(s.storage.saveMediaStream).not.toHaveBeenCalled()
  s.redis.eval.mockImplementation(original)
  await s.service.part('admin', upload.id, 0, sha(bytes), Readable.from([bytes]))
  s.restore.mockRejectedValueOnce(new Error('raw-private-storage-error'))
  await s.service.complete('admin', upload.id, confirmation)
  expect(await awaitTerminal(s.service, upload.id)).toMatchObject({ state: 'failed', error: 'session_restore_failed' })
  expect(JSON.stringify([...s.data.values()])).not.toContain('raw-private-storage-error')
})
