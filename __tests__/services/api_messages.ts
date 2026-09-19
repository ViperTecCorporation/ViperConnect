import express from 'express'
import request from 'supertest'
import { apiMessage, replyWithoutQuoteWarning } from '../../src/services/api_messages'
import { apiErrorLocalization, localizeApiError } from '../../src/services/api_error_localization'
import { SendError } from '../../src/services/send_error'
import { normalizeProviderSendError, shouldReturnProviderSendFailure } from '../../src/services/providers/send_failure'

describe('public error language', () => {
  it('defaults to Brazilian Portuguese and preserves the internal error', () => {
    const error = new SendError(404, 'zapo_phone_lid_not_found: 5511000000000')
    const result = normalizeProviderSendError('zapo', 'text', error)
    expect(result.message).toContain('Não foi possível localizar')
    expect(result.code).toBe(404)
    expect(result.error_data.reason).toBe('zapo_phone_lid_not_found')
    expect(error.title).toBe('zapo_phone_lid_not_found: 5511000000000')
  })
  it('supports English explicitly', () => {
    expect(apiMessage('zapo_phone_lid_not_found: 1', 'en')).toContain('Could not find')
    expect(apiMessage('REPLY_SENT_WITHOUT_QUOTE', 'en')).toContain('without a quote')
  })
  it('does not invent the reason for provider rejection', () => {
    expect(apiMessage('negative publish ack: tag=ack error=479')).toBe('O WhatsApp recusou a mensagem (código 479).')
    expect(apiMessage('negative publish ack: error=479', 'en')).toContain('code 479')
  })
  it('preserves retry classification', () => {
    expect(shouldReturnProviderSendFailure('zapo', new SendError(503, 'zapo_client_not_connected'), { countRetries: 0, maxRetries: 3 })).toBe(false)
  })
  it('localizes errors only, preserving codes and metadata', () => {
    expect(localizeApiError({ error: { code: 404, message: 'message_not_found: id', error_data: { reason: 'message_not_found' } } }))
      .toEqual({ error: { code: 404, error_code: 'message_not_found', message: 'A mensagem original não foi localizada.', error_data: { reason: 'message_not_found' } } })
    expect(localizeApiError(null)).toBeNull()
    expect(apiMessage('unknown')).toBe('unknown')
    expect(replyWithoutQuoteWarning().code).toBe('REPLY_SENT_WITHOUT_QUOTE')
  })
  it('localizes JSON/send-object HTTP failures once and leaves success content unchanged', async () => {
    const app = express()
    app.use(apiErrorLocalization)
    app.get('/error', (_req, res) => res.status(404).send({ error: 'message_not_found: id' }))
    app.get('/ok', (_req, res) => res.json({ message: 'message_not_found: this is user text' }))
    expect((await request(app).get('/error')).body.error).toBe('A mensagem original não foi localizada.')
    expect((await request(app).get('/ok')).body.message).toBe('message_not_found: this is user text')
  })
})
