import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionDatabase } from '../../src/services/session_storage/database'
import { NATIVE_MESSAGE_ALIVE_SQL, NATIVE_MESSAGE_EXPIRED_SQL, NATIVE_RECORD_DEADLINE_SQL } from '../../src/services/session_storage/native_expiry_sql'

let root: string, db: SessionDatabase
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uno-expiry-query-plan-'))
  db = new SessionDatabase(join(root, 'session.sqlite'))
  db.exec('CREATE TABLE mailbox_messages(session_id TEXT,message_id TEXT,timestamp_ms INTEGER,PRIMARY KEY(session_id,message_id))')
})

test('upsert deadline aggregates only two exact primary-key reads, including earlier imported bytes and missing deadlines', () => {
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', `retired-${i}`, 1])
    db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', 'record', 200])
    db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', 'record:message_bytes', 100])
  })
  const args = ['msg', 'record', 'msg', 'record:message_bytes']
  expect(db.get(NATIVE_RECORD_DEADLINE_SQL, args)?.deadline).toBe(100)
  expect(db.get(NATIVE_RECORD_DEADLINE_SQL, ['msg', 'absent', 'msg', 'absent:message_bytes'])?.deadline).toBeNull()
  const plan = db.all('EXPLAIN QUERY PLAN ' + NATIVE_RECORD_DEADLINE_SQL, args).map(row => row.detail).filter(s => /SEARCH uno_native_expiry/.test(s))
  expect(plan).toHaveLength(2)
  for (const step of plan) expect(step).toMatch(/\(domain=\? AND record_id=\?\)/)
})
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

test('message and imported byte deadlines preserve exact expiry semantics without a per-message deadline-range scan', () => {
  const now = Date.now()
  db.transaction(() => {
    for (const id of ['message-expired', 'bytes-expired', 'future', 'no-deadline']) db.run('INSERT INTO mailbox_messages VALUES(?,?,?)', ['session', id, now])
    for (const [id, expires] of [['message-expired', now], ['bytes-expired:message_bytes', now - 1], ['future', now + 1000]] as const) db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', id, expires])
    // Real history contains large retired-key populations. The query must look
    // up this message, never rescan those unrelated expired records per row.
    for (let index = 0; index < 2000; index++) db.run('INSERT INTO uno_native_expiry VALUES(?,?,?)', ['msg', `unrelated-${index}`, 1])
  })
  for (const [predicate, expected] of [[NATIVE_MESSAGE_ALIVE_SQL, ['future', 'no-deadline']], [NATIVE_MESSAGE_EXPIRED_SQL, ['bytes-expired', 'message-expired']]] as const) {
    const sql = `SELECT m.message_id FROM mailbox_messages m WHERE m.session_id=? AND (${predicate}) ORDER BY m.message_id`
    expect(db.all(sql, ['session', now, now]).map(row => row.message_id)).toEqual(expected)
    const lookups = db.all(`EXPLAIN QUERY PLAN ${sql}`, ['session', now, now]).map(row => row.detail).filter(value => /SEARCH e /.test(value))
    expect(lookups).toHaveLength(2)
    for (const lookup of lookups) expect(lookup).toMatch(/\(domain=\? AND record_id=\?\)/)
  }
})
