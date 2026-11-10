import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageCapability, requireStorageVolume } from '../../src/services/session_storage/capability'

const names = ['SESSION_STORAGE_ROOT', 'SESSION_STORAGE_PERSISTENT', 'SESSION_STORAGE_DEFAULT', 'UNOAPI_SERVER_NAME', 'UNOAPI_STORAGE_WORKER_ID'] as const
let root: string
const previous = Object.fromEntries(names.map(key => [key, process.env[key]]))
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'uno-capability-')); for (const key of names) delete process.env[key]; process.env.UNOAPI_SERVER_NAME = 'synthetic_worker' })
afterEach(() => { rmSync(root, { recursive: true, force: true }); for (const key of names) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] })

test('SQLite is unavailable without explicit persistent-volume configuration', () => {
  expect(storageCapability()).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(() => requireStorageVolume()).toThrow('persistent_volume_not_configured')
})
test('an existing host directory and ENV assertion alone are not proof of a mounted worker volume', () => {
  process.env.SESSION_STORAGE_ROOT = root; process.env.SESSION_STORAGE_PERSISTENT = 'true'; process.env.SESSION_STORAGE_DEFAULT = 'sqlite'
  // This temporary host directory is intentionally not a dedicated Docker mount.
  expect(storageCapability()).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(() => requireStorageVolume()).toThrow('persistent_mount_not_detected')
  expect(readdirSync(root)).toEqual([])
})
test('missing and filesystem-root destinations cannot enable SQLite defaults', () => {
  process.env.SESSION_STORAGE_ROOT = join(root, 'missing'); process.env.SESSION_STORAGE_PERSISTENT = 'true'; process.env.SESSION_STORAGE_DEFAULT = 'sqlite'
  expect(storageCapability().sqliteAvailable).toBe(false)
})

test('unsafe SQLite engine keeps new sessions on Redis before preparing files even with storage configured', () => {
  process.env.SESSION_STORAGE_ROOT = root; process.env.SESSION_STORAGE_PERSISTENT = 'true'; process.env.SESSION_STORAGE_DEFAULT = 'sqlite'
  expect(storageCapability(() => ({ available: false, version: '3.51.2', reason: 'session_storage_sqlite_version_unsupported' })))
    .toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_sqlite_version_unsupported' })
  expect(readdirSync(root)).toEqual([])
})
