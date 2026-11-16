import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { resolve, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sqliteEngineCapability } from './sqlite_engine'

export const DEFAULT_SESSION_STORAGE_ROOT = '/home/u/app/session-data'
export const LEGACY_SESSION_STORAGE_ROOT = '/app/session-data'

function persistentMount(root: string) {
  if (process.platform !== 'linux') return undefined
  const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => ({
    target: line.split(' ')[4]?.replace(/\\040/g, ' '), filesystem: line.split(' - ')[1]?.split(' ')[0],
  })).filter(({ target }) => target && target !== '/' && (root === target || root.startsWith(target + '/')))
    .sort((a, b) => b.target.length - a.target.length)[0]
  return mount?.filesystem && !['tmpfs', 'ramfs', 'overlay'].includes(mount.filesystem) ? mount : undefined
}

export const storageRoot = () => {
  if (process.env.SESSION_STORAGE_ROOT) return resolve(process.env.SESSION_STORAGE_ROOT)
  // An existing legacy mount wins even if a new mount is also present. Never
  // silently redirect existing databases to an empty directory during upgrades.
  try { if (existsSync(LEGACY_SESSION_STORAGE_ROOT) && persistentMount(LEGACY_SESSION_STORAGE_ROOT)) return LEGACY_SESSION_STORAGE_ROOT } catch { /* Capability still requires a verified mount. */ }
  return resolve(DEFAULT_SESSION_STORAGE_ROOT)
}

/** Routing uses server names; a separate, divergent storage-worker alias is not supported. */
export function storageWorkerIdentity(environment: NodeJS.ProcessEnv = process.env) {
  const server = environment.UNOAPI_SERVER_NAME, worker = environment.UNOAPI_STORAGE_WORKER_ID
  const validName = (value: string | undefined): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
  if (!validName(server)) return { valid: false, reason: 'session_storage_server_name_required', server: undefined, worker: undefined }
  if (worker && (!validName(worker) || worker !== server)) return { valid: false, reason: 'session_storage_worker_identity_ambiguous', server, worker: validName(worker) ? worker : undefined }
  return { valid: true, reason: undefined, server, worker: server }
}

const warnedEngines = new Set<string>()
export function storageCapability(engineProbe = sqliteEngineCapability) {
  let reason = 'session_storage_persistent_volume_not_configured'
  let available = false
  const root = storageRoot()
  const requestedDefault = process.env.SESSION_STORAGE_DEFAULT || 'sqlite'
  const persistenceAllowed = !process.env.SESSION_STORAGE_PERSISTENT || process.env.SESSION_STORAGE_PERSISTENT === 'true'
  const identity = storageWorkerIdentity()
  const engine = engineProbe()
  if (!engine.available && persistenceAllowed && (requestedDefault === 'sqlite' || process.env.SESSION_STORAGE_PERSISTENT === 'true')) {
    const key = engine.reason || 'session_storage_sqlite_native_unavailable'
    if (!warnedEngines.has(key)) {
      warnedEngines.add(key)
      module.require('../logger').default.warn({ code: key }, 'SQLite session storage disabled: native SQLite engine is unavailable or unsafe for WAL')
    }
  }
  if (persistenceAllowed && root !== parse(root).root && existsSync(root)) {
    if (!identity.valid) reason = identity.reason!
    else if (!engine.available) reason = engine.reason || 'session_storage_sqlite_native_unavailable'
    else try {
      // Docker mounts must be observable by the worker, not merely asserted by ENV.
      if (!persistentMount(root)) reason = 'session_storage_persistent_mount_not_detected'
      else {
        const path = resolve(root, `.storage-write-probe-${randomUUID()}`)
        const fd = openSync(path, 'wx', 0o600); closeSync(fd); unlinkSync(path)
        available = true; reason = ''
      }
    } catch { reason = 'session_storage_volume_not_writable' }
  }
  return { sqliteAvailable: available, reason: reason || undefined, root, workerIdentity: identity,
    defaultBackend: available && requestedDefault === 'sqlite' ? 'sqlite' : 'redis',
    documentation: '/guide/session-storage',
    configurationExample: {
      env: `UNOAPI_SERVER_NAME=${identity.server || 'worker_1'}\n# UNOAPI_STORAGE_WORKER_ID must be absent or equal to ${identity.server || 'worker_1'}\nSESSION_STORAGE_DEFAULT=sqlite\nSESSION_STORAGE_ROOT=${root}\nSESSION_STORAGE_PERSISTENT=true`,
      compose: `services:\n  worker-zapo:\n    volumes:\n      - zapo-sessions:${root}\nvolumes:\n  zapo-sessions: {}`,
    } }
}

export function requireStorageVolume() {
  const capability = storageCapability()
  if (!capability.sqliteAvailable) throw new Error(capability.reason)
  mkdirSync(resolve(storageRoot(), 'session-storage'), { recursive: true, mode: 0o700 })
  return storageRoot()
}
