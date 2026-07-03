import { v1 as uuid } from 'uuid'
import { UNOAPI_RESTRICTION_TIME_ZONE } from '../defaults'
import { normalizeUserOrGroupIdForWebhook } from './transformer'

type RestrictionNoticeContext = {
  phone: string
  payload: any
  unoMessageId: string
  statusPayload: any
  timestamp: string
}

type RestrictionNoticeInfo = {
  destination: string
  restrictionUntilIso: string
  restrictionUntilFormatted: string
  body: string
}

const getStatus = (statusPayload: any) =>
  statusPayload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]

const getRestrictionError = (statusPayload: any) => {
  const status = getStatus(statusPayload)
  const error = status?.errors?.[0]
  if (`${error?.code || ''}` !== '463') return undefined
  const reachout = error?.error_data?.reachout
  const restrictionUntilIso = `${reachout?.timeEnforcementEnds || ''}`.trim()
  if (!restrictionUntilIso) return undefined
  return { error, reachout, restrictionUntilIso }
}

export const formatRestrictionEnd = (
  iso: string,
  timeZone = UNOAPI_RESTRICTION_TIME_ZONE,
): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date)
}

const summarizeOriginalMessage = (payload: any): string => {
  const type = `${payload?.type || ''}`.trim()
  if (!type) return '<sem tipo>'
  const value = payload?.[type]
  if (type === 'text') {
    const body = `${value?.body || ''}`.replace(/\s+/g, ' ').trim()
    return body ? body.slice(0, 240) : '<texto vazio>'
  }
  if (value?.caption) return `${type}: ${`${value.caption}`.replace(/\s+/g, ' ').trim().slice(0, 200)}`
  if (value?.filename) return `${type}: ${value.filename}`
  return type
}

export const getRestrictionNoticeInfo = (ctx: RestrictionNoticeContext): RestrictionNoticeInfo | undefined => {
  const restriction = getRestrictionError(ctx.statusPayload)
  if (!restriction) return undefined
  const status = getStatus(ctx.statusPayload)
  const destination = normalizeUserOrGroupIdForWebhook(
    status?.recipient_id || ctx.payload?.to || restriction.error?.error_data?.from || '',
  )
  const original = summarizeOriginalMessage(ctx.payload)
  const reason = `${restriction.error?.error_data?.reason || 'message_account_restriction'}`
  const restrictionUntilFormatted = formatRestrictionEnd(restriction.restrictionUntilIso)
  const body = [
    'Mensagem nao enviada pelo WhatsApp.',
    '',
    `Contato: ${destination || '<desconhecido>'}`,
    `Mensagem: ${ctx.unoMessageId}`,
    `Motivo: ausencia de token para iniciar/retomar esta conversa. Codigo 463 (${reason}).`,
    `Restricao ativa ate: ${restrictionUntilFormatted}.`,
    '',
    `Conteudo original: ${original}`,
  ].join('\n')

  return {
    destination,
    restrictionUntilIso: restriction.restrictionUntilIso,
    restrictionUntilFormatted,
    body,
  }
}

const buildTextWebhook = (
  phone: string,
  contactWaId: string,
  id: string,
  timestamp: string,
  body: string,
) => ({
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
            contacts: [
              {
                wa_id: contactWaId,
                profile: {
                  name: contactWaId,
                },
              },
            ],
            messages: [
              {
                from: phone,
                id,
                timestamp,
                text: { body },
                type: 'text',
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
})

export const buildRestrictionNoticeWebhooks = (ctx: RestrictionNoticeContext): any[] => {
  const info = getRestrictionNoticeInfo(ctx)
  if (!info?.destination) return []
  const phone = ctx.phone.replace('+', '')
  const ownerBody = [
    info.body,
    '',
    `Sessao: ${phone}`,
  ].join('\n')

  return [
    buildTextWebhook(phone, info.destination, uuid(), ctx.timestamp, info.body),
    buildTextWebhook(phone, phone, uuid(), ctx.timestamp, ownerBody),
  ]
}
