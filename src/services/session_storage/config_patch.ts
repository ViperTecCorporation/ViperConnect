import { isDeepStrictEqual } from 'node:util'
import { SendError } from '../send_error'

const fences = ['sessionStorage', 'sessionStorageTaskId', 'sessionStorageUnlinked', 'sessionStorageProvisionPending', 'sessionStorageProvisioned',
  'server', 'provider', 'autoConnect', 'authToken', 'mobilePrimaryDraftId', 'mobilePrimaryImported', 'mobilePrimaryDeleting', 'sessionTransferDeleting']
const has = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value || {}, key)

/** A generic config patch may not install/remove a backend or clear a pending
 * bootstrap. Dedicated owner/catalog CAS operations own those transitions. */
export function assertSafeSessionConfigPatch(current: any, patch: any, baseline?: { config: any; strict?: boolean }) {
  const conflict = () => { throw new SendError(409, 'session_storage_configuration_changed') }
  if (baseline?.config && !current) conflict()
  if (baseline && fences.some(key => !isDeepStrictEqual(baseline.config?.[key], current?.[key])) && (baseline.strict || fences.some(key => has(patch, key)))) conflict()
  if (has(patch, 'sessionStorage') && !isDeepStrictEqual(patch.sessionStorage, current?.sessionStorage)) {
    const before = current?.sessionStorage, after = patch.sessionStorage
    const unlink = before?.backend === 'sqlite' && !['migrating', 'restoring'].includes(before.state) && patch.autoConnect === false && patch.sessionStorageUnlinked === true
      && isDeepStrictEqual({ ...before, state: 'offline' }, after)
    if (!unlink) conflict()
  }
  for (const key of ['sessionStorageTaskId', 'sessionStorageProvisioned']) {
    if (has(patch, key) && !isDeepStrictEqual(patch[key], current?.[key])) conflict()
  }
  const pending = current?.sessionStorageProvisionPending
  if (pending) {
    if (patch.autoConnect === true) throw new SendError(409, 'session_storage_provision_unconfirmed')
    if (has(patch, 'sessionStorageProvisionPending') && (!patch.sessionStorageProvisionPending
      || pending.id && pending.id !== patch.sessionStorageProvisionPending.id)) conflict()
  } else if (current && patch.sessionStorageProvisionPending) conflict()
  if (current?.mobilePrimaryDraftId && current.mobilePrimaryImported !== true && patch.autoConnect === true) throw new SendError(409, 'mobile_auth_import_required')
  if (current?.sessionStorage?.backend === 'sqlite') {
    if (has(patch, 'server') && patch.server !== current.server || has(patch, 'provider') && patch.provider !== current.provider) conflict()
    if (patch.autoConnect === true && ['migrating', 'restoring'].includes(current.sessionStorage.state)) throw new SendError(409, 'session_storage_operation_in_progress')
  }
}
