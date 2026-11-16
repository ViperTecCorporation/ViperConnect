import type { Config } from '../config'
import type { WaStoreSession } from 'zapo-js'
import { assertLocalStorageOwner, isSqliteSession } from './routing'
import { SessionStorageError } from './types'
import { clearZapoSession } from '../zapo/zapo_session_cleanup'

export type PrimaryUnlinkFence = { key: string; token: string }
export interface PrimaryUnlinkDependencies {
  readLease(key: string): Promise<string | null>
  hasClient(phone: string): boolean
  session(phone: string, config: Config): WaStoreSession
  release(config: Config): Promise<void>
}
const dependencies: PrimaryUnlinkDependencies = {
  readLease: async key => (await module.require('../redis').getRedis()).get(key),
  hasClient: phone => module.require('../client').clients.has(phone),
  session: (phone, config) => module.require('../zapo/zapo_store_registry').zapoStoreRegistry.get(config, phone).session(phone),
  release: config => module.require('../zapo/zapo_store_registry').zapoStoreRegistry.release(config),
}

/** Local credential cleanup only. The deleting coordinator owns the socket lease. */
export async function unlinkSqlitePrimary(phone: string, config: Config, draftId: string, fence: PrimaryUnlinkFence,
  deps: PrimaryUnlinkDependencies = dependencies) {
  assertLocalStorageOwner(config)
  if (!isSqliteSession(config) || !draftId || draftId !== config.mobilePrimaryDraftId || config.mobilePrimaryDeleting !== true
    || config.autoConnect !== false || ['migrating', 'restoring'].includes(config.sessionStorage!.state)
    || deps.hasClient(phone)) throw new SessionStorageError(409, 'session_storage_primary_unlink_requires_suspension')
  const assertFence = async () => {
    if (!fence || fence.key !== `unoapi-lease:zapo-session:${phone}` || typeof fence.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(fence.token)
      || await deps.readLease(fence.key) !== fence.token) throw new SessionStorageError(409, 'session_storage_primary_unlink_lease_lost')
  }
  await assertFence()
  try {
    await clearZapoSession(deps.session(phone, config), { preserveHistory: true })
    await assertFence()
    return { cleared: true, historyPreserved: true, storagePreserved: true }
  } finally { await deps.release(config) }
}
