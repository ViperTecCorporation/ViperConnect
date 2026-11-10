import type { Config } from '../config'
import { SendError } from '../send_error'

// Provenance belongs to the resolved configuration, not the public JSON. It
// cannot be supplied by a register payload or inherited from environment defaults.
const persisted = new WeakMap<Config, boolean>()

export function markSessionConfigRegistration(config: Config, registered: boolean) {
  persisted.set(config, registered)
}

/** The register/Primary flow must confirm the owner's backend before a socket. */
export function assertSessionConfigRegistered(config: Config) {
  if (config.useRedis && persisted.get(config) === false) {
    throw new SendError(409, 'session_storage_registration_required')
  }
  if (config.sessionStorageProvisionPending) throw new SendError(409, 'session_storage_provision_unconfirmed')
  if (config.mobilePrimaryDraftId && config.mobilePrimaryImported !== true) throw new SendError(409, 'mobile_auth_import_required')
}
