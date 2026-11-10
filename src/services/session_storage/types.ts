export type SessionStorageBackend = 'redis' | 'sqlite'
export interface SessionStorageDescriptor {
  backend: SessionStorageBackend
  storageId: string
  owner: string
  generation: number
  state: 'active' | 'migrating' | 'restoring' | 'offline'
  fixture?: boolean
}

export class SessionStorageError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'SessionStorageError' }
}

export function validateSessionPhone(phone: string) {
  if (typeof phone !== 'string' || !/^[1-9]\d{7,14}$/.test(phone)) throw new SessionStorageError(400, 'session_storage_phone_invalid')
}

export function validateStorageDescriptor(value: unknown): asserts value is SessionStorageDescriptor {
  const d = value as SessionStorageDescriptor
  if (!d || !['redis', 'sqlite'].includes(d.backend) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(d.storageId)
    || typeof d.owner !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(d.owner) || !Number.isSafeInteger(d.generation) || d.generation < 1
    || !['active', 'migrating', 'restoring', 'offline'].includes(d.state) || d.fixture !== undefined && typeof d.fixture !== 'boolean') {
    throw new SessionStorageError(400, 'session_storage_descriptor_invalid')
  }
}

export interface SessionStorageRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export interface StorageProgress { phase: string; processed?: number; total?: number }
export interface StorageTask {
  id: string; phone: string; operation: 'migration' | 'backup' | 'restore' | 'source-cleanup'
  status: 'running' | 'ready' | 'failed' | 'interrupted'
  createdAt: number; updatedAt: number; progress: StorageProgress
  error?: string; result?: unknown
}

/** Never contains a path, Redis URL, backup password or provider credentials. */
export function publicStorageDescriptor(value: SessionStorageDescriptor) {
  validateStorageDescriptor(value)
  return { backend: value.backend, storageId: value.storageId, owner: value.owner, generation: value.generation, state: value.state }
}
