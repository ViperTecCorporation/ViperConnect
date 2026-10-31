import type { Request, Response } from 'express'
import type { Incoming } from '../services/incoming'
import type { getConfig } from '../services/config'
import { contactCryptoUserId } from '../services/contacts/contact_crypto'
import { SendError } from '../services/send_error'
import { resolveWhatsAppEngine } from '../services/providers/provider_resolver'

export class ContactCryptoController {
  constructor(private readonly incoming: Incoming, private readonly getConfig: getConfig) {}

  async recover(req: Request, res: Response) {
    try {
      const userId = contactCryptoUserId(req.body?.user_id)
      if (req.body?.confirm !== true) throw new SendError(400, 'contact_crypto_confirmation_required')
      const config = await this.getConfig(req.params.phone)
      if (resolveWhatsAppEngine(config.provider) !== 'zapo' || !this.incoming.recoverContactCrypto) {
        throw new SendError(409, 'contact_crypto_requires_zapo')
      }
      return res.status(200).send(await this.incoming.recoverContactCrypto(req.params.phone, userId))
    } catch (error) {
      const code = error instanceof SendError ? error.code : Number(`${(error as Error)?.message || ''}`.match(/^(\d{3}):/)?.[1])
      const status = code >= 400 && code <= 599 ? code : 502
      const title = error instanceof SendError ? error.title : status === 502 ? 'contact_crypto_recovery_unconfirmed' : `${(error as Error).message}`.replace(/^\d{3}:\s*/, '')
      if (status === 429) res.setHeader('Retry-After', '300')
      return res.status(status).send({ error: title })
    }
  }
}
