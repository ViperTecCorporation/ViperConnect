import fs from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_SESSION_STORAGE_ROOT, storageCapability, storageRoot } from '../../src/services/session_storage/capability'

// These fixtures emulate Linux Docker paths even when Jest runs on Windows.
jest.mock('node:path', () => {
  const actual = jest.requireActual('node:path')
  return { ...actual, resolve: actual.posix.resolve, parse: actual.posix.parse }
})

const names = ['SESSION_STORAGE_ROOT', 'SESSION_STORAGE_DEFAULT', 'SESSION_STORAGE_PERSISTENT', 'UNOAPI_BASE_STORE', 'UNOAPI_SERVER_NAME', 'UNOAPI_STORAGE_WORKER_ID'] as const
const previous = Object.fromEntries(names.map(key => [key, process.env[key]]))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const engine = () => ({ available: true, version: '3.53.4' })
let mounts: string
beforeEach(() => {
  for (const key of names) delete process.env[key]
  process.env.UNOAPI_SERVER_NAME = 'synthetic_worker'
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  mounts = `25 1 8:1 / / rw - ext4 /dev/root rw\n26 25 8:1 /volumes/sessions ${storageRoot()} rw - ext4 /dev/root rw`
  jest.spyOn(fs, 'existsSync').mockReturnValue(true)
  jest.spyOn(fs, 'readFileSync').mockImplementation(() => mounts)
  jest.spyOn(fs, 'openSync').mockReturnValue(42)
  jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined)
  jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined)
})
afterEach(() => {
  jest.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  for (const key of names) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
})

test('new sessions default to SQLite and its dedicated path with a verified volume, without storage ENVs', () => {
  process.env.UNOAPI_BASE_STORE = '/legacy-data'
  expect(storageRoot()).toBe(resolve(DEFAULT_SESSION_STORAGE_ROOT))
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: true, defaultBackend: 'sqlite', reason: undefined })
  expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining('.storage-write-probe-'), 'wx', 0o600)
})

test('a missing mount falls back to Redis without writing files, including when ENVs assert persistence', () => {
  mounts = '25 1 8:1 / / rw - ext4 /dev/root rw'
  for (const asserted of [false, true]) {
    if (asserted) process.env.SESSION_STORAGE_PERSISTENT = 'true'
    expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_persistent_mount_not_detected' })
  }
  expect(fs.openSync).not.toHaveBeenCalled()
})

test.each(['tmpfs', 'ramfs', 'overlay'])('a %s mount is not accepted as persistent SQLite storage', filesystem => {
  mounts = `26 25 0:1 / ${storageRoot()} rw - ${filesystem} memory rw`
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(fs.openSync).not.toHaveBeenCalled()
})

test('a volatile nested mount cannot inherit persistence from an enclosing disk mount', () => {
  process.env.SESSION_STORAGE_ROOT = '/app/session-data'
  mounts = '26 25 8:1 /volumes/app /app rw - ext4 /dev/root rw'
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: true, defaultBackend: 'sqlite' })
  jest.mocked(fs.openSync).mockClear()
  mounts += '\n27 26 0:1 / /app/session-data rw - tmpfs tmpfs rw'
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(fs.openSync).not.toHaveBeenCalled()
})

test('an explicitly configured root remains supported and must be mounted', () => {
  process.env.SESSION_STORAGE_ROOT = '/custom-sessions'
  expect(storageCapability(engine).sqliteAvailable).toBe(false)
  mounts = `26 25 8:1 /volumes/sessions ${storageRoot()} rw - ext4 /dev/root rw`
  expect(storageRoot()).toBe(resolve('/custom-sessions'))
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: true, defaultBackend: 'sqlite' })
})

test('an explicit Redis default remains Redis without disabling migration capability', () => {
  process.env.SESSION_STORAGE_DEFAULT = 'redis'
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: true, defaultBackend: 'redis' })
})

test('an explicit persistence opt-out disables SQLite even with a valid mount', () => {
  process.env.SESSION_STORAGE_PERSISTENT = 'false'
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(fs.openSync).not.toHaveBeenCalled()
})

test('a missing directory or read-only volume cannot become the SQLite default', () => {
  jest.mocked(fs.existsSync).mockReturnValue(false)
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis' })
  expect(fs.openSync).not.toHaveBeenCalled()
  jest.mocked(fs.existsSync).mockReturnValue(true)
  jest.mocked(fs.openSync).mockImplementation(() => { throw new Error('read-only filesystem') })
  expect(storageCapability(engine)).toMatchObject({ sqliteAvailable: false, defaultBackend: 'redis', reason: 'session_storage_volume_not_writable' })
})
