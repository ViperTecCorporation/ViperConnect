import { Outgoing } from './outgoing'
import { v1 as uuid } from 'uuid'
import { getConfig, setConfig } from './redis'
import type { OnNewLogin } from './login_types'
import { t } from '../i18n'
import { SendError } from './send_error'
import { assertSessionEffectsAllowed } from './session_storage/routing'
import { assertSessionConfigRegistered } from './session_storage/connection_registration'
import { assertSafeSessionConfigPatch } from './session_storage/config_patch'

export const onNewLoginGenerateToken = (outgoing: Outgoing): OnNewLogin => {
  return async (phone: string) => {
    const config = await getConfig(phone)
    if (!config) throw new SendError(409, 'session_storage_registration_required')
    assertSessionEffectsAllowed(config)
    assertSessionConfigRegistered(config)
    if (config.autoConnect === false) throw new SendError(409, 'session_storage_session_suspended')
    const authToken = config.authToken || `${uuid()}${uuid()}`.replaceAll('-', '')
    // A late pairing callback must not recreate a removed session, replace the
    // selected backend, or overwrite a newer token/storage generation.
    await setConfig(phone, { authToken }, { expectedExisting: true, expectedConfig: config })
    const current = await getConfig(phone)
    if (!current) throw new SendError(409, 'session_storage_registration_required')
    assertSessionEffectsAllowed(current)
    assertSessionConfigRegistered(current)
    assertSafeSessionConfigPatch(current, {}, { config: { ...config, authToken }, strict: true })
    const message = t('on_read_qrcode', authToken)
    const payload = {
      from: phone,
      type: 'text',
      text: {
        body: message,
      },
    }
    return outgoing.formatAndSend(phone, phone, payload)
  }
}
