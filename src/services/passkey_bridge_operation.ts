import type { Config } from './config'
import { clients } from './client'
import { SendError } from './send_error'
import { getPasskeyBridgeSession, updatePasskeyBridgeSession } from './passkey_bridge'
import { assertSessionEffectsAllowed, storageOwner } from './session_storage/routing'

export type PasskeyBridgeOperation = 'assertion' | 'confirm'
export type PasskeyBridgePayload = { credentialId: Buffer; assertionJson: string }
export type PasskeyBridgeResult = { bridgeId: string; status: string; providerManagedConfirmation?: boolean }

/** Runs only on the owning worker and never creates a client or connects a session. */
export async function executePasskeyBridgeOperation(phone: string, config: Config, action: PasskeyBridgeOperation, bridgeId: string,
  payload?: PasskeyBridgePayload): Promise<PasskeyBridgeResult> {
  if (!['assertion', 'confirm'].includes(action) || !/^[A-Za-z0-9_-]{1,100}$/.test(bridgeId)) throw new SendError(400, 'passkey_bridge_invalid_operation')
  if ((config.sessionStorage?.owner || config.server || 'server_1') !== storageOwner()) throw new SendError(409, 'session_storage_wrong_owner')
  assertSessionEffectsAllowed(config)
  const session = await getPasskeyBridgeSession(bridgeId)
  if (!session || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new SendError(404, 'passkey_bridge_not_found_or_expired')
  if (session.phone !== phone || session.bridgeId !== bridgeId) throw new SendError(409, 'passkey_bridge_session_mismatch')
  if (action === 'confirm' && session.status === 'completed') return { bridgeId, status: session.status, providerManagedConfirmation: true }
  if (config.autoConnect !== true || config.mobilePrimaryDeleting) throw new SendError(409, 'passkey_bridge_session_not_active')
  const client = clients.get(phone)
  if (!client) throw new SendError(409, 'passkey_bridge_session_not_active')
  if (action === 'assertion') {
    if (session.status !== 'request') throw new SendError(409, 'passkey_bridge_assertion_not_pending')
    if (!payload || !Buffer.isBuffer(payload.credentialId) || !payload.credentialId.length || typeof payload.assertionJson !== 'string' || !payload.assertionJson) throw new SendError(400, 'passkey_bridge_invalid_assertion')
    if (!client.sendPasskeyResponse) throw new SendError(409, 'passkey_bridge_response_unavailable')
    const result = await client.sendPasskeyResponse(payload, bridgeId)
    if (result?.ok?.success !== true || result.ok.bridge_id !== bridgeId) throw new SendError(502, 'passkey_bridge_result_unconfirmed')
    const updated = await updatePasskeyBridgeSession(bridgeId, { status: 'response-sent' })
    if (!updated || updated.phone !== phone || updated.bridgeId !== bridgeId || !Number.isFinite(Date.parse(updated.expiresAt)) || Date.parse(updated.expiresAt) <= Date.now()
      || !['response-sent', 'completed'].includes(updated.status)) throw new SendError(409, 'passkey_bridge_result_unconfirmed')
    return { bridgeId, status: updated.status }
  }
  if (!['response-sent', 'confirmation'].includes(session.status)) throw new SendError(409, 'passkey_bridge_confirmation_not_pending')
  if (!client.sendPasskeyConfirmation) throw new SendError(409, 'passkey_bridge_confirmation_unavailable')
  const result = await client.sendPasskeyConfirmation(bridgeId)
  if (result?.ok?.success !== true) throw new SendError(502, 'passkey_bridge_result_unconfirmed')
  const providerManaged = result.ok.provider_managed_confirmation === true
  if (providerManaged && result.ok.bridge_id !== bridgeId) throw new SendError(502, 'passkey_bridge_result_unconfirmed')
  const updated = providerManaged ? await getPasskeyBridgeSession(bridgeId) : await updatePasskeyBridgeSession(bridgeId, { status: 'completed' })
  if (!updated || updated.phone !== phone || updated.bridgeId !== bridgeId || !Number.isFinite(Date.parse(updated.expiresAt)) || Date.parse(updated.expiresAt) <= Date.now()
    || !['response-sent', 'confirmation', 'completed'].includes(updated.status)) throw new SendError(409, 'passkey_bridge_result_unconfirmed')
  return { bridgeId, status: updated.status, providerManagedConfirmation: providerManaged }
}
