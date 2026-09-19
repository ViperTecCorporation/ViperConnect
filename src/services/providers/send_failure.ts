import type { WhatsAppEngine } from './provider_types'
import { SendError } from '../send_error'
import { apiMessage } from '../api_messages'

type RetryContext = {
  countRetries: number
  maxRetries: number
}

type FailureResponseInput = {
  phone: string
  recipientId: string
  messageId: string
  messageType: string
  provider: WhatsAppEngine
  timestamp: string | number
  error: unknown
}

const numericCode = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 500
}

const cleanTitle = (value: unknown): string => {
  return `${value || ''}`.trim().replace(/^\d+\s*:\s*/, '')
}

export const isZapoClientNotConnected = (error: unknown): boolean => {
  const value = error as any
  return [
    value?.message,
    value?.title,
  ].some((field) => `${field || ''}`.includes('zapo_client_not_connected'))
}

export const shouldReturnProviderSendFailure = (
  provider: WhatsAppEngine,
  error: unknown,
  retry?: RetryContext,
): boolean => {
  if (provider !== 'zapo') return false
  if (isZapoClientNotConnected(error)) {
    return !retry || retry.countRetries >= retry.maxRetries
  }
  if (error instanceof SendError) return true
  if (!retry) return true
  return retry.countRetries >= retry.maxRetries
}

export const normalizeProviderSendError = (
  provider: WhatsAppEngine,
  messageType: string,
  error: unknown,
) => {
  const value = error as any
  const payload = value?.output?.payload
  const message = `${value?.message || payload?.message || value || 'provider_send_failed'}`.trim()
  const code = numericCode(
    value?.code,
    value?.data,
    value?.statusCode,
    value?.errorCode,
    value?.cause?.code,
    payload?.statusCode,
  )
  const title = cleanTitle(
    value?.title
    || payload?.error
    || payload?.message
    || message
    || 'provider_send_failed',
  )
  const sourceErrorData = value?.error_data || value?.errorData
  const errorData = {
    ...(sourceErrorData && typeof sourceErrorData === 'object' ? sourceErrorData : {}),
    provider,
    message_type: messageType || 'unknown',
    ...(/^[a-z][a-z0-9_-]+(?:\s*:|$)/.test(title) && !sourceErrorData?.reason ? { reason: title.split(':')[0].trim() } : {}),
  }

  return {
    code,
    title: apiMessage(title || 'provider_send_failed', undefined, 'provider_send_failed'),
    message: apiMessage(message, undefined, 'provider_send_failed'),
    error_data: errorData,
  }
}

export const buildProviderSendFailureResponse = ({
  phone,
  recipientId,
  messageId,
  messageType,
  provider,
  timestamp,
  error,
}: FailureResponseInput) => {
  const isGroup = recipientId.endsWith('@g.us')
  return {
    ok: undefined,
    error: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phone,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: phone,
                  phone_number_id: phone,
                },
                statuses: [
                  {
                    id: messageId,
                    recipient_id: recipientId,
                    ...(isGroup ? { recipient_type: 'group' } : {}),
                    status: 'failed',
                    timestamp: Number(timestamp),
                    errors: [
                      normalizeProviderSendError(provider, messageType, error),
                    ],
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    },
  }
}
