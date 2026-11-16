import { sqliteEngineCapability, type SafeSqliteEngine } from '../../src/services/session_storage/sqlite_engine'

function fixture(version: string) {
  const close = jest.fn(), open = jest.fn(() => ({ prepare: () => ({ get: () => ({ version }) }), close, exec: jest.fn() }))
  const engine = { DatabaseSync: open, backup: jest.fn(async () => 0) } as unknown as SafeSqliteEngine
  return { close, open, load: jest.fn(() => engine) }
}

test('probes the real SQLite version in memory once per loader and closes its diagnostic connection', () => {
  const f = fixture('3.53.4')
  expect(sqliteEngineCapability(f.load)).toEqual({ available: true, version: '3.53.4' })
  expect(sqliteEngineCapability(f.load).available).toBe(true)
  expect(f.load).toHaveBeenCalledTimes(1); expect(f.open).toHaveBeenCalledWith(':memory:'); expect(f.close).toHaveBeenCalledTimes(1)
})

test('unsafe WAL versions and missing native SQLite never become an available storage capability', () => {
  const f = fixture('3.51.2')
  expect(sqliteEngineCapability(f.load)).toEqual({ available: false, version: '3.51.2', reason: 'session_storage_sqlite_version_unsupported' })
  expect(f.close).toHaveBeenCalledTimes(1)
  const missing = () => { throw new Error('private path or dependency details must not escape') }
  const result = sqliteEngineCapability(missing)
  expect(result).toEqual({ available: false, version: undefined, reason: 'session_storage_sqlite_native_unavailable' })
  expect(JSON.stringify(result)).not.toContain('private')
})
