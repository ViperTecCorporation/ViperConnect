import { SendError } from '../../src/services/send_error'
import {
  buildProviderSendFailureResponse,
  isZapoClientNotConnected,
  normalizeProviderSendError,
  shouldReturnProviderSendFailure,
} from '../../src/services/providers/send_failure'

describe('provider send failure', () => {
  test('returns known Zapo send errors immediately', () => {
    expect(shouldReturnProviderSendFailure(
      'zapo',
      new SendError(404, 'zapo_phone_lid_not_found'),
      { countRetries: 1, maxRetries: 5 },
    )).toBe(true)
  })

  test('keeps native Zapo errors retryable until the last attempt', () => {
    const error = new Error('socket temporarily unavailable')

    expect(shouldReturnProviderSendFailure(
      'zapo',
      error,
      { countRetries: 1, maxRetries: 5 },
    )).toBe(false)
    expect(shouldReturnProviderSendFailure(
      'zapo',
      error,
      { countRetries: 5, maxRetries: 5 },
    )).toBe(true)
  })

  test('keeps a disconnected Zapo client retryable while the worker reconnects', () => {
    const error = new SendError(409, 'zapo_client_not_connected')

    expect(isZapoClientNotConnected(error)).toBe(true)
    expect(shouldReturnProviderSendFailure(
      'zapo',
      error,
      { countRetries: 1, maxRetries: 5 },
    )).toBe(false)
    expect(shouldReturnProviderSendFailure(
      'zapo',
      error,
      { countRetries: 5, maxRetries: 5 },
    )).toBe(true)
  })

  test('does not change the Baileys exception policy', () => {
    expect(shouldReturnProviderSendFailure(
      'baileys',
      new SendError(11, 'invalid_image_payload'),
      { countRetries: 5, maxRetries: 5 },
    )).toBe(false)
  })

  test('normalizes structured provider errors without exposing the stack', () => {
    const error = Object.assign(new Error('463: account restricted'), {
      code: 463,
      title: 'Account restricted',
      error_data: { reason: 'message_account_restriction' },
    })

    expect(normalizeProviderSendError('zapo', 'text', error)).toEqual({
      code: 463,
      title: 'O WhatsApp informou uma restrição na conta.',
      message: 'O WhatsApp informou uma restrição na conta.',
      error_data: {
        reason: 'message_account_restriction',
        provider: 'zapo',
        message_type: 'text',
      },
    })
  })

  test('normalizes native Zapo output payload errors', () => {
    const error = {
      output: {
        payload: {
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'rate-overlimit',
        },
      },
    }

    expect(normalizeProviderSendError('zapo', 'interactive', error)).toEqual({
      code: 429,
      title: 'Limite de solicitações atingido. Aguarde antes de tentar novamente.',
      message: 'Limite de solicitações atingido. Aguarde antes de tentar novamente.',
      error_data: {
        provider: 'zapo',
        message_type: 'interactive',
      },
    })
  })

  test('builds the Cloud API compatible failed status envelope', () => {
    const response = buildProviderSendFailureResponse({
      phone: '5566999999999',
      recipientId: '120363040468224422@g.us',
      messageId: 'uno-message-1',
      messageType: 'document',
      provider: 'zapo',
      timestamp: '1783000000',
      error: new SendError(11, 'document_download_failed'),
    })

    expect(response.error.entry[0].changes[0].value.statuses[0]).toEqual({
      id: 'uno-message-1',
      recipient_id: '120363040468224422@g.us',
      recipient_type: 'group',
      status: 'failed',
      timestamp: 1783000000,
      errors: [{
        code: 11,
        title: 'Não foi possível baixar o documento para envio.',
        message: 'Não foi possível baixar o documento para envio.',
        error_data: {
          reason: 'document_download_failed',
          provider: 'zapo',
          message_type: 'document',
        },
      }],
    })
  })
})
