/* eslint-disable @typescript-eslint/no-explicit-any */
import type { WaClient, WaSendMessageContent, WaSendMessageOptions } from 'zapo-js'
import fetch from 'node-fetch'
import { getMimetype, toBaileysMessageContent } from '../transformer'
import { SendError } from '../send_error'
import { SEND_AUDIO_MESSAGE_AS_PTT } from '../../defaults'

const mediaTypes = ['image', 'audio', 'document', 'video', 'sticker'] as const

const resolveMedia = async (type: string, link: string) => {
  if (!/^https?:\/\//i.test(link)) return link
  const response = await fetch(link)
  if (!response.ok) throw new SendError(11, `${type}_download_failed: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const normalizeMention = (value: unknown) => {
  const raw = `${value || ''}`.trim().replace(/^@/, '')
  if (!raw) return undefined
  return raw.includes('@') ? raw : `${raw}@s.whatsapp.net`
}

const getMentions = (payload: any) => {
  const explicit = Array.isArray(payload?.mentions)
    ? payload.mentions
    : (Array.isArray(payload?.text?.mentions) ? payload.text.mentions : [])
  const body = `${payload?.text?.body || ''}`
  const fromBody = Array.from(body.matchAll(/@(\d{8,20})\b/g)).map((match) => match[1])
  return Array.from(new Set([...explicit, ...fromBody].map(normalizeMention).filter(Boolean))) as string[]
}

const pollContent = (payload: any): WaSendMessageContent => {
  const poll = payload?.poll || payload
  const name = `${poll?.name || poll?.question || poll?.title || ''}`.trim()
  const rawOptions = Array.isArray(poll?.options)
    ? poll.options
    : (Array.isArray(poll?.values) ? poll.values : [])
  const options = rawOptions.map((option: any) => (
    typeof option === 'string'
      ? option.trim()
      : `${option?.name || option?.optionName || option?.title || ''}`.trim()
  )).filter(Boolean)
  const selectableCount = Number(
    poll?.selectableCount
      ?? poll?.selectable_count
      ?? poll?.selectableOptionsCount
      ?? poll?.selectable_options_count
      ?? 1,
  )

  if (!name) throw new SendError(400, 'poll_name_required')
  if (!options.length) throw new SendError(400, 'poll_options_required')
  if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > options.length) {
    throw new SendError(400, 'invalid_poll_selectable_count')
  }

  return {
    type: 'poll',
    name,
    options,
    selectableCount,
    allowAddOption: !!(poll?.allowAddOption ?? poll?.allow_add_option),
    hideParticipantName: !!(poll?.hideParticipantName ?? poll?.hide_participant_name),
  }
}

export type ZapoMappedMessage = {
  content: WaSendMessageContent
  options: Pick<WaSendMessageOptions, 'mentions'>
}

const nativeButton = (button: any) => {
  if (button?.type === 'url' || button?.type === 'cta_url' || button?.url) {
    const value = button.url || button
    const url = typeof value === 'string' ? value : value.link || value.url || ''
    return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: button.text || value.title || 'Abrir', url, merchant_url: url }) }
  }
  if (button?.type === 'call' || button?.type === 'cta_call' || button?.call) {
    const value = button.call || button
    return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: button.text || value.title || 'Ligar', phone_number: value.phone_number || value.phone || '' }) }
  }
  if (button?.type === 'cta_copy' || button?.copy_code || button?.copy) {
    const value = button.copy_code || button.copy || button
    return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: button.text || value.title || 'Copiar', copy_code: value.code || value.copy_code || '' }) }
  }
  const value = button?.reply || button
  return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: value?.title || value?.text || value?.displayText || '', id: value?.id || value?.buttonId || '' }) }
}

const interactiveHeader = async (client: WaClient, header: any) => {
  if (!header || !header.type || header.type === 'text') {
    return { title: `${header?.text || ''}`, hasMediaAttachment: false }
  }
  const type = `${header.type}` as 'image' | 'video' | 'document'
  const media = header[type] || {}
  const link = `${media.link || media.url || ''}`.trim()
  if (!link) return { title: '', hasMediaAttachment: false }
  const response = await fetch(link)
  if (!response.ok) throw new SendError(11, `interactive_header_download_failed: HTTP ${response.status}`)
  const mimetype = media.mime_type || media.mimetype || response.headers.get('content-type') || getMimetype({ type, [type]: { link } })
  const upload = await client.message.upload(new Uint8Array(await response.arrayBuffer()), { type, mimetype })
  return {
    title: `${header.text || ''}`,
    hasMediaAttachment: true,
    [`${type}Message`]: { ...upload, ...(media.filename ? { fileName: media.filename } : {}) },
  }
}

const interactiveContent = async (client: WaClient, payload: any): Promise<WaSendMessageContent> => {
  const interactive = payload?.interactive || {}
  const action = interactive.action || {}
  const body = interactive.body?.text ? { text: `${interactive.body.text}` } : undefined
  const footer = interactive.footer?.text ? { text: `${interactive.footer.text}` } : undefined
  const header = await interactiveHeader(client, interactive.header)

  if (Array.isArray(action.sections) && action.sections.length) {
    const sections = action.sections.map((section: any) => ({
      title: `${section?.title || ''}`,
      rows: (section?.rows || []).map((row: any) => ({
        id: `${row?.id || row?.rowId || ''}`,
        rowId: `${row?.rowId || row?.id || ''}`,
        title: `${row?.title || ''}`,
        description: `${row?.description || ''}`,
      })),
    }))
    return {
      interactiveMessage: {
        header,
        body,
        footer,
        nativeFlowMessage: {
          buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: action.button || 'Selecione', sections }) }],
          messageVersion: 1,
        },
      },
    } as WaSendMessageContent
  }

  const carousel = interactive.carousel || action.carousel
  if (interactive.type === 'carousel' || carousel) {
    const cards = await Promise.all((carousel?.cards || []).map(async (card: any) => ({
      header: await interactiveHeader(client, card?.header),
      body: card?.body?.text ? { text: `${card.body.text}` } : undefined,
      footer: card?.footer?.text ? { text: `${card.footer.text}` } : undefined,
      nativeFlowMessage: {
        buttons: (card?.action?.buttons || []).map(nativeButton),
        messageVersion: 1,
      },
    })))
    if (cards.length < 2 || cards.length > 10) throw new SendError(400, 'interactive_carousel_requires_2_to_10_cards')
    return {
      interactiveMessage: {
        header,
        body,
        footer,
        carouselMessage: { cards, messageVersion: 1, carouselCardType: 0 },
      },
    } as WaSendMessageContent
  }

  return {
    interactiveMessage: {
      header,
      body,
      footer,
      nativeFlowMessage: {
        buttons: (action.buttons || []).map(nativeButton),
        messageVersion: 1,
      },
    },
  } as WaSendMessageContent
}

export const toZapoMessageContent = async (
  client: WaClient,
  payload: any,
  customMessageCharactersFunction: (message: string) => string = (message) => message,
): Promise<ZapoMappedMessage> => {
  const type = `${payload?.type || ''}`
  const mentions = getMentions(payload)
  if (type === 'text' || type === 'message_edit') {
    return {
      content: {
        type: 'text',
        text: customMessageCharactersFunction(`${payload?.text?.body || ''}`),
      },
      options: mentions.length ? { mentions } : {},
    }
  }

  if ((mediaTypes as readonly string[]).includes(type)) {
    const media = payload?.[type] || {}
    const link = `${media.link || ''}`.trim()
    if (!link) throw new SendError(11, `invalid_${type}_payload: missing link`)
    const isPtt = type === 'audio' && (SEND_AUDIO_MESSAGE_AS_PTT || media.ptt === true || payload?.ptt === true)
    return {
      content: {
        type,
        media: await resolveMedia(type, link),
        mimetype: media.mime_type || media.mimetype || getMimetype(payload) || undefined,
        ...(isPtt ? { ptt: true } : {}),
        ...(media.caption ? { caption: customMessageCharactersFunction(media.caption) } : {}),
        ...(media.filename ? { fileName: media.filename } : {}),
      } as WaSendMessageContent,
      options: mentions.length ? { mentions } : {},
    }
  }

  if (type === 'baileys') return { content: payload.message || {}, options: {} }

  if (type === 'poll') return { content: pollContent(payload), options: {} }

  if (type === 'interactive') {
    return { content: await interactiveContent(client, payload), options: mentions.length ? { mentions } : {} }
  }

  if (type === 'contacts') {
    const legacyContent = toBaileysMessageContent(payload, customMessageCharactersFunction) as any
    if (legacyContent.contacts) {
      return {
        content: { contactsArrayMessage: legacyContent.contacts },
        options: {},
      }
    }
    return { content: legacyContent, options: mentions.length ? { mentions } : {} }
  }

  throw new SendError(400, `unsupported_zapo_message_type: ${type || '<empty>'}`)
}
