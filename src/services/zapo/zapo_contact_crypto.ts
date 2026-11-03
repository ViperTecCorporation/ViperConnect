import type { WaClient, WaStoreSession } from 'zapo-js'
import { getRedis } from '../redis'
import { SendError } from '../send_error'
import logger from '../logger'
import { contactCryptoUserId, type ContactCryptoResult } from '../contacts/contact_crypto'

export const CONTACT_CRYPTO_COOLDOWN_SECONDS = 300

export const reserveContactCryptoRecovery = async (phone: string, userId: string): Promise<boolean> => {
  const redis = await getRedis()
  return await redis.set(`unoapi:contact-crypto:${phone}:${userId}`, '1', { NX: true, EX: CONTACT_CRYPTO_COOLDOWN_SECONDS }) === 'OK'
}

export class ZapoContactCrypto {
  constructor(
    private readonly client: Pick<WaClient, 'message'>,
    private readonly contacts: WaStoreSession['contacts'],
    private readonly phone: string,
    private readonly reserve = reserveContactCryptoRecovery,
  ) {}

  async recover(value: unknown): Promise<ContactCryptoResult> {
    const userId = contactCryptoUserId(value)
    if (!await this.contacts.getByJid(userId)) throw new SendError(404, 'contact_not_found')
    if (!await this.reserve(this.phone, userId)) throw new SendError(429, 'contact_crypto_recovery_cooldown')
    // Keep the reservation on failure: a failed request may already have changed the session.
    logger.info({ phone: this.phone, userId }, 'ZAPO_CONTACT_CRYPTO_RECOVERY_STARTED')
    try {
      // Official zapo-js 1.11.0 API: rebuild this address, preserving the identity.
      // Do not request identity changes, clear other devices or resend messages.
      await this.client.message.syncSignalSession(userId, { force: true })
    } catch {
      logger.warn({ phone: this.phone, userId }, 'ZAPO_CONTACT_CRYPTO_RECOVERY_FAILED')
      throw new SendError(502, 'contact_crypto_recovery_failed')
    }
    logger.info({ phone: this.phone, userId }, 'ZAPO_CONTACT_CRYPTO_RECOVERY_COMPLETED')
    return { success: true, user_id: userId, resent: false, cooldown_seconds: CONTACT_CRYPTO_COOLDOWN_SECONDS }
  }
}
