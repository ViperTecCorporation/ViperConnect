import type { SessionStorageGateway } from '../../controllers/session_storage_controller'

// Do not initialize workers/config/store modules while constructing public HTTP routes.
export const sessionStorageGateway = Object.fromEntries(['status', 'metrics', 'explore', 'mutate', 'migrate', 'task', 'backup', 'restore', 'sourceCleanup', 'restoreUpload'].map(method => [method,
  (...args: unknown[]) => module.require('./runtime').sessionStorageGateway[method](...args),
])) as unknown as SessionStorageGateway
