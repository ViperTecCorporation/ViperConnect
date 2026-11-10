import { Request, Response } from 'express'
import logger from '../services/logger'
import { Contact } from '../services/contact'
import type { ContactDirectory } from '../services/contacts/contact_directory_types'
import { SendError } from '../services/send_error'
import type { ContactBook } from '../services/contacts/contact_book'
import type { SaveContactInput } from '../services/contacts/contact_book_types'

export const parseSaveContactInput = (body: Record<string, unknown>): SaveContactInput => {
  const phoneNumber = `${body?.phone_number || ''}`.replace(/\D/g, '')
  const fullName = `${body?.full_name || ''}`.trim()
  const firstName = `${body?.first_name || ''}`.trim()
  const userId = `${body?.user_id || ''}`.trim()
  const username = `${body?.username || ''}`.trim().replace(/^@/, '')

  if (!/^\d{7,15}$/.test(phoneNumber)) throw new SendError(400, 'contact_phone_number_must_have_7_to_15_digits')
  if (!fullName || fullName.length > 256) throw new SendError(400, 'contact_full_name_must_have_1_to_256_characters')
  if (firstName.length > 128) throw new SendError(400, 'contact_first_name_must_have_at_most_128_characters')
  if (userId && !/^\d+@lid$/.test(userId)) throw new SendError(400, 'contact_user_id_must_be_a_lid')
  if (username.length > 64) throw new SendError(400, 'contact_username_must_have_at_most_64_characters')

  return {
    phone_number: phoneNumber,
    full_name: fullName,
    ...(firstName ? { first_name: firstName } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(username ? { username } : {}),
  }
}

export class ContactsController {
  private service: Contact

  constructor(
    service: Contact,
    private readonly directory?: ContactDirectory,
    private readonly contactBook?: ContactBook,
  ) {
    this.service = service
  }

  public async save(req: Request, res: Response) {
    if (!this.contactBook) return res.status(501).send({ error: 'contact_book_not_configured' })
    try {
      const input = parseSaveContactInput(req.body || {})
      return res.status(200).send(await this.contactBook.save(req.params.phone, input))
    } catch (error) {
      if (error instanceof SendError && error.code >= 400 && error.code <= 599) {
        return res.status(error.code).send({ error: error.title })
      }
      const message = `${(error as Error)?.message || 'contact_save_failed'}`
      const statusFromMessage = Number(message.match(/^(\d{3}):/)?.[1])
      if (statusFromMessage >= 400 && statusFromMessage <= 599) {
        return res.status(statusFromMessage).send({ error: message.replace(/^\d{3}:\s*/, '') })
      }
      logger.warn(error as Error, 'Address-book contact save failed for %s', req.params.phone)
      return res.status(500).send({ error: message })
    }
  }

  public async get(req: Request, res: Response) {
    if (!this.directory) return res.status(501).send({ error: 'contact_directory_not_configured' })
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    const cursor = req.query.cursor === undefined ? undefined : `${req.query.cursor}`
    const search = req.query.search === undefined ? undefined : `${req.query.search}`.trim()
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return res.status(400).send({ error: 'limit_must_be_between_1_and_200' })
    }
    if (cursor !== undefined && !/^\d+$/.test(cursor)) {
      return res.status(400).send({ error: 'cursor_must_be_numeric' })
    }
    if (search && search.length < 3) {
      return res.status(400).send({ error: 'search_must_have_at_least_3_characters' })
    }
    if (search && search.length > 100) {
      return res.status(400).send({ error: 'search_must_have_at_most_100_characters' })
    }

    try {
      return res.status(200).send(await this.directory.list(req.params.phone, { cursor, limit, search }))
    } catch (error) {
      if (error instanceof SendError && error.code >= 400 && error.code <= 599) {
        return res.status(error.code).send({ error: error.title })
      }
      // Express 4 does not consume rejected async route promises. A transport
      // failure must fail this request, not terminate the entire web process.
      logger.warn({ phone: req.params.phone, code: 'contact_directory_unavailable' }, 'Contact directory unavailable')
      return res.status(503).send({ error: 'contact_directory_unavailable' })
    }
  }

  public async post(req: Request, res: Response) {
    logger.debug('contacts post method %s', req.method)
    logger.debug('contacts post headers %s', JSON.stringify(req.headers))
    logger.debug('contacts post params %s', JSON.stringify(req.params))
    logger.debug('contacts post body %s', JSON.stringify(req.body))
    const { phone } = req.params
    try {
      const contacts = await this.service.verify(phone, req.body.contacts || [], req.body.webhook)
      return res.status(200).send(contacts)
    } catch (error) {
      const message = `${(error as Error)?.message || 'contact_verification_failed'}`
      const statusFromMessage = Number(message.match(/^(\d{3}):/)?.[1])
      const status = error instanceof SendError ? error.code : statusFromMessage >= 400 && statusFromMessage <= 599 ? statusFromMessage : 500
      logger.warn(error as Error, 'Contact verification failed for %s', phone)
      return res.status(status).send({ error: message.replace(/^\d{3}:\s*/, '') })
    }
  }
}
