import { SendError } from '../send_error'

export type ContactCryptoResult = { success: true; user_id: string; resent: false; cooldown_seconds: number }

export const contactCryptoUserId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{1,32}@lid$/.test(value)) {
    throw new SendError(400, 'contact_user_id_must_be_a_lid')
  }
  return value
}
