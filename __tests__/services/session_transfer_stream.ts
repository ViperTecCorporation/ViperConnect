import { backupLines, encryptSessionStream, decryptSessionStream, FRAME_BYTES } from '../../src/services/session_transfer/archive_stream'
import { validateStreamMeta, restoreStagedStream } from '../../src/services/session_transfer/stream_restore'
import { validateStreamRecord, sessionRecords, sessionKeys, AUTH_SUFFIXES } from '../../src/services/session_transfer/stream_records'
import { recoverBackupConnection } from '../../src/services/session_transfer/backup_recovery'

const phone = '999123456789', prefix = 'unoapi:zapo:', password = 'synthetic-password'
const meta = { kind: 'linked-session', version: 2, zapo: '1.9.0', redisStore: '1.3.0', phone, name: 'Synthetic', identityJid: phone + ':3@s.whatsapp.net', mode: 'complete', createdAt: '2026-10-05T00:00:00Z' }
async function* sequence(values: any[]) { yield* values }
const collect = async (source: AsyncIterable<any>) => { const result = []; for await (const item of source) result.push(item); return result }
const credentialRecords = () => AUTH_SUFFIXES.map(suffix => ({ key: `auth:${phone}${suffix}`, dump: 'AQ==' }))

test('export failure restores only an owned previous connection state and never enables a previously suspended session', async () => {
  for (const previous of [true, false, undefined]) for (const owned of [0, 1]) {
    const redis: any = { eval: jest.fn().mockResolvedValue(owned) }, reconnect = jest.fn()
    expect(await recoverBackupConnection(redis, 'config', phone, 'owner', previous, reconnect)).toBe(owned === 1)
    expect(reconnect).toHaveBeenCalledTimes(owned === 1 && previous !== false ? 1 : 0)
    expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'config', JSON.stringify(previous ?? true), phone, 'owner'])
  }
})

test('streaming archive exceeds legacy byte and key limits without truncation or a whole-file buffer', async () => {
  let size = 0, records = 0
  async function* input() { for (let i = 0; i < 60001; i++) yield { key: `msg:${phone}:${i}`, dump: 'AQ=='.repeat(100) } }
  async function* encrypted() { for await (const chunk of encryptSessionStream(meta, input(), password)) { size += chunk.length; expect(chunk.length).toBeLessThan(6 * 1024 * 1024); yield chunk } }
  for await (const frame of decryptSessionStream(encrypted(), password)) if (frame.kind === 'records') records += frame.value.length
  expect(records).toBe(60001); expect(size).toBeGreaterThan(16 * 1024 * 1024)
})

test('frame parser accepts byte boundaries, rejects overlong or incomplete lines', async () => {
  expect(await collect(backupLines(sequence([Buffer.from('one'), Buffer.from('\ntwo\n')])))).toEqual(['one', 'two'])
  await expect(collect(backupLines(sequence(['12345\n']), 4))).rejects.toThrow()
  await expect(collect(backupLines(sequence(['one'])))).rejects.toThrow()
  await expect(collect(backupLines(sequence(['\n'])))).rejects.toThrow()
})

test('archive rejects wrong password, missing end, reordering, corruption and trailing frames', async () => {
  const frames = await collect(encryptSessionStream(meta, sequence(credentialRecords()), password))
  await expect(collect(decryptSessionStream(sequence(frames), 'different-password'))).rejects.toThrow()
  for (const input of [[], frames.slice(0, -1), [frames[0], frames[2], frames[1], frames[3]], [...frames, frames[1]], [Buffer.from('{}\n'), ...frames.slice(1)]]) {
    await expect(collect(decryptSessionStream(sequence(input), password))).rejects.toThrow()
  }
  const changed = JSON.parse(frames[1].toString()); changed.tag = Buffer.alloc(16).toString('base64')
  await expect(collect(decryptSessionStream(sequence([frames[0], JSON.stringify(changed) + '\n', ...frames.slice(2)]), password))).rejects.toThrow()
  await expect(collect(encryptSessionStream(meta, sequence(['x'.repeat(FRAME_BYTES)]), password))).rejects.toThrow()
})

test('metadata and records stay session-scoped, with canonical dumps and expiry validation', () => {
  expect(() => validateStreamMeta(meta)).not.toThrow()
  for (const value of [{ ...meta, version: 1 }, { ...meta, phone: '*' }, { ...meta, identityJid: '123456789:3@s.whatsapp.net' }, { ...meta, name: 'x'.repeat(81) }, { ...meta, mode: 'other' }, { ...meta, createdAt: 'bad' }, { ...meta, records: [] }]) expect(() => validateStreamMeta(value)).toThrow()
  const record = credentialRecords()[0]
  expect(() => validateStreamRecord(record, phone, 'complete')).not.toThrow()
  for (const value of [{ ...record, key: 'auth:123456789' }, { ...record, dump: '@' }, { ...record, expiresAt: -1 }, { ...record, namespace: 'foreign' }, { ...record, token: 'x' }, { ...record, dump: 'A'.repeat(2000001) }, {}]) expect(() => validateStreamRecord(value, phone, 'complete')).toThrow()
})

test('metadata accepts only equivalent BR mobile ninth-digit aliases without rewriting native identity', () => {
  for (const [sessionPhone, identityPhone] of [['5566996222471', '556696222471'], ['556696222471', '5566996222471']]) {
    const value = { ...meta, phone: sessionPhone, identityJid: `${identityPhone}:5@s.whatsapp.net` }
    expect(() => validateStreamMeta(value)).not.toThrow()
    expect(value.identityJid).toBe(`${identityPhone}:5@s.whatsapp.net`)
    expect(value.phone).toBe(sessionPhone)
  }
  for (const identityJid of ['556696222472:5@s.whatsapp.net', '556596222471:5@s.whatsapp.net',
    '546696222471:5@s.whatsapp.net', '556696222471@s.whatsapp.net', '556696222471:5@lid', undefined, 123]) {
    expect(() => validateStreamMeta({ ...meta, phone: '5566996222471', identityJid })).toThrow('session_backup_incompatible')
  }
  for (const [sessionPhone, identityPhone] of [['5566932222471', '556632222471'], ['5466996222471', '546696222471']]) {
    expect(() => validateStreamMeta({ ...meta, phone: sessionPhone, identityJid: `${identityPhone}:5@s.whatsapp.net` })).toThrow()
  }
})

test('BR alias metadata never bypasses the staged credential identity check', async () => {
  const s = restoreFixture(), brPhone = '5566996222471'
  const records = AUTH_SUFFIXES.map(suffix => ({ key: `auth:${brPhone}${suffix}`, dump: 'AQ==' }))
  s.deps.identity.mockResolvedValue(false)
  await expect(restoreStagedStream(s.redis, { ...meta, phone: brPhone, identityJid: '556696222471:5@s.whatsapp.net' } as any,
    s.frames(records), prefix, s.deps)).rejects.toThrow('mobile_backup_identity_mismatch')
  expect(s.data.size).toBe(0); expect(s.lists.size).toBe(0)
})

test('SCAN duplicates are deduplicated off-process and expired keys are skipped; temporary state is deleted', async () => {
  const keys = credentialRecords().map(r => prefix + r.key)
  const seen = new Set<string>()
  const redis: any = {
    scan: jest.fn().mockResolvedValueOnce(['0', [...keys, keys[0], prefix + `msg:${phone}:expired`, prefix + 'auth:123456789']]).mockResolvedValue(['0', []]),
    sadd: jest.fn(async (_set, key) => { if (seen.has(key)) return 0; seen.add(key); return 1 }), expire: jest.fn(), del: jest.fn(),
    pipeline: jest.fn(() => ({ pttl() { return this }, callBuffer(_command: string, key: string) { this.key = key; return this }, async exec() { return this.key.endsWith('expired') ? [[null, -2], [null, null]] : [[null, -1], [null, Buffer.from([1])]] }, key: '' })),
  }
  const renew = jest.fn()
  expect(await collect(sessionRecords(redis, prefix, phone, 'complete', renew))).toHaveLength(9)
  expect(renew).toHaveBeenCalled(); expect(redis.del).toHaveBeenCalled()
  redis.scan.mockResolvedValue(['0', []])
  await expect(collect(sessionRecords(redis, prefix, phone, 'credentials', renew))).rejects.toThrow('session_backup_registered_linked_required')
  expect(await collect(sessionKeys(redis, prefix, phone, 'complete'))).toEqual([])
})

const restoreFixture = () => {
  const data = new Map<string, unknown>(), lists = new Map<string, string[]>()
  const redis: any = {
    expire: jest.fn(), persist: jest.fn(), exists: jest.fn(async key => data.has(key) ? 1 : 0),
    rpush: jest.fn(async (key, value) => { lists.set(key, [...(lists.get(key) || []), value]) }),
    lrange: jest.fn(async (key, from, to) => (lists.get(key) || []).slice(from, to + 1)),
    restore: jest.fn(async (key, _ttl, dump) => data.set(key, dump)),
    del: jest.fn(async (...keys) => { for (const key of keys) { data.delete(key); lists.delete(key) } }),
    eval: jest.fn(async (script, count, ...args) => {
      const keys = args.slice(0, count)
      if (script.includes("local expiry=")) { for (let i = 2; i < keys.length; i += 2) { data.set(keys[i + 1], data.get(keys[i])); data.delete(keys[i]) } }
      else if (script.includes("redis.call('SADD'")) data.set(keys[1], args[count + 1])
      else if (script.includes("for i=3,#KEYS do")) for (const key of keys.slice(2)) data.delete(key)
      return 1
    }),
  }
  const deps = { lease: 'lease', token: 'token', configKey: 'config', indexKey: 'index', config: { provider: 'zapo' }, renew: jest.fn(), identity: jest.fn(async () => true) }
  const frames = (records = credentialRecords()) => sequence([{ kind: 'records', value: records }, { kind: 'end', count: records.length }])
  return { redis, deps, data, lists, frames }
}

test('restoration is staged; only bounded batches are promoted after authentication and identity checks', async () => {
  const s = restoreFixture()
  const records = [...credentialRecords(), ...Array.from({ length: 240 }, (_, i) => ({ key: `msg:${phone}:${i}`, dump: 'AQ==' }))]
  expect(await restoreStagedStream(s.redis, meta as any, s.frames(records), prefix, s.deps)).toEqual({ phone, restored: true })
  expect(s.data.has('config')).toBe(true); expect(s.lists.size).toBe(0)
  expect(s.redis.eval.mock.calls.filter(([script]: any) => script.includes('local expiry=')).length).toBe(3)
  expect(Math.max(...s.redis.eval.mock.calls.map((args: any[]) => args[1]))).toBeLessThanOrEqual(202)
})

test('invalid, duplicate, incomplete and wrong-identity imports clean staging without activating the destination', async () => {
  for (const kind of ['duplicate', 'missing', 'identity', 'no-end', 'expired', 'wrong-count']) {
    const s = restoreFixture(), records = credentialRecords()
    if (kind === 'duplicate') records.push(records[0])
    if (kind === 'missing') records.shift()
    if (kind === 'identity') s.deps.identity.mockResolvedValue(false)
    const input = kind === 'no-end' ? sequence([{ kind: 'records', value: records }])
      : kind === 'wrong-count' ? sequence([{ kind: 'records', value: records }, { kind: 'end', count: 0 }])
        : kind === 'expired' ? s.frames(records.map(r => ({ ...r, expiresAt: 1 }))) : s.frames(records)
    await expect(restoreStagedStream(s.redis, meta as any, input, prefix, s.deps)).rejects.toThrow()
    expect(s.data.size).toBe(0); expect(s.lists.size).toBe(0)
  }
})

test('failed promotion rolls back previous batches; lost fencing never deletes foreign target data', async () => {
  for (const lost of [false, true]) {
    const s = restoreFixture(), records = [...credentialRecords(), ...Array.from({ length: 150 }, (_, i) => ({ key: `msg:${phone}:${i}`, dump: 'AQ==' }))]
    const original = s.redis.eval.getMockImplementation(); let batches = 0
    s.redis.eval.mockImplementation(async (...args: any[]) => {
      if (args[0].includes('local expiry=') && ++batches === 2) return 0
      if (lost && args[0].includes('for i=3,#KEYS do')) return 0
      return original(...args)
    })
    await expect(restoreStagedStream(s.redis, meta as any, s.frames(records), prefix, s.deps)).rejects.toThrow(lost ? 'session_restore_rollback_pending' : 'mobile_restore_destination_exists')
    expect(s.data.has('config')).toBe(false)
    if (!lost) { expect(s.data.size).toBe(0); expect(s.lists.size).toBe(0) }
    else expect(s.lists.size).toBe(1)
  }
})

test('lost promotion response retains metadata for review instead of hiding partially promoted keys', async () => {
  const s = restoreFixture(), original = s.redis.eval.getMockImplementation()
  s.redis.eval.mockImplementation(async (...args: any[]) => {
    const result = await original(...args)
    if (args[0].includes('local expiry=')) throw new Error('connection lost after execution')
    return result
  })
  await expect(restoreStagedStream(s.redis, meta as any, s.frames(), prefix, s.deps)).rejects.toThrow('session_restore_rollback_pending')
  expect(s.redis.persist).toHaveBeenCalled(); expect(s.lists.size).toBe(1)
  expect(s.data.has('config')).toBe(false)
  expect([...s.lists.values()][0].every(entry => !entry.includes('dump'))).toBe(true)
})
