import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionDatabase } from '../../src/services/session_storage/database'
import { createNativeSnapshotReader } from '../../src/services/session_storage/snapshot_reader'

const phone = '5566999999999', prefix = 'test:zapo:'
let root: string, db: SessionDatabase
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uno-snapshot-reader-')); db = new SessionDatabase(join(root, 'test.sqlite'))
  db.exec('CREATE TABLE uno_redis_types(key TEXT PRIMARY KEY,type TEXT NOT NULL,expires_at INTEGER)')
})
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

test('all read commands and pipelines preserve exact bytes, text, nulls and the fixed deadline', async () => {
  const stamp = Date.now(), key = `${prefix}msg:${phone}:provider`, binary = `${key}:message_bytes`, payload = Buffer.from([0, 128, 255])
  db.run('INSERT INTO uno_redis_types VALUES(?,?,?),(?,?,?)', [key, 'hash', stamp + 1000, binary, 'string', stamp + 1000])
  db.run('INSERT INTO uno_hash(key,field,value) VALUES(?,?,?),(?,?,?)', [key, 'text', Buffer.from('olá'), key, 'bytes', payload])
  db.putValue(binary, payload, { expiresAt: stamp + 1000 })
  const reader = createNativeSnapshotReader(db, phone, prefix, stamp)
  expect(await reader.getBuffer(binary)).toEqual(payload)
  expect(await reader.get(binary)).toBe(payload.toString())
  expect(await reader.hgetBuffer(key, 'bytes')).toEqual(payload)
  expect(await reader.hget(key, 'text')).toBe('olá')
  expect(await reader.hget(key, 'absent')).toBeNull()
  expect(await reader.hgetallBuffer(key)).toEqual({ text: Buffer.from('olá'), bytes: payload })
  expect(await reader.hgetall(key)).toEqual({ text: 'olá', bytes: payload.toString() })
  expect(await reader.pipeline().hgetall(key).getBuffer(binary).exec()).toEqual([[null, { text: 'olá', bytes: payload.toString() }], [null, payload]])
  const expired = createNativeSnapshotReader(db, phone, prefix, stamp + 1001)
  expect(await expired.getBuffer(binary)).toBeNull()
  expect(await expired.hgetall(key)).toEqual({})
  expect(await expired.hget(key, 'text')).toBeNull()
  expect(await reader.getBuffer(`${key}:absent`)).toBeNull()
})

test('refuses malformed scope, cross-session access, wrong types, missing payload and mutation commands', async () => {
  const stamp = Date.now(), key = `${prefix}msg:${phone}:provider`
  expect(() => createNativeSnapshotReader(db, '../bad', prefix, stamp)).toThrow('scope_invalid')
  const reader = createNativeSnapshotReader(db, phone, prefix, stamp)
  await expect(reader.get('foreign:auth:' + phone)).rejects.toThrow('scope_invalid')
  await expect(reader.get(`${prefix}auth:5511999999999`)).rejects.toThrow('scope_invalid')
  db.run('INSERT INTO uno_redis_types VALUES(?,?,?)', [key, 'string', null])
  await expect(reader.hgetall(key)).rejects.toThrow('type_mismatch')
  await expect(reader.getBuffer(key)).rejects.toThrow('value_missing')
  expect(() => reader.set(key, 'must-not-write')).toThrow('command_unsupported')
  expect(() => reader.pipeline().del(key)).toThrow('command_unsupported')
})
