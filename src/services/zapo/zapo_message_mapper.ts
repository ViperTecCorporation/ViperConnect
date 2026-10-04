/* eslint-disable @typescript-eslint/no-explicit-any */
import { proto } from 'zapo-js'
import type { WaClient, WaSendMessageContent, WaSendMessageOptions } from 'zapo-js'
import fetch from 'node-fetch'
import { v4 as uuid } from 'uuid'
import { getMimetype, toBaileysMessageContent } from '../transformer'
import { SendError } from '../send_error'
import { SEND_AUDIO_MESSAGE_AS_PTT } from '../../defaults'
import { zapoMediaProcessor } from './zapo_media_processor'
import { zapoLegacyPdfNormalizer } from './zapo_legacy_pdf'
import { normalizeAutomaticLinkPreview } from '../messages/automatic_link_preview'
import { normalizeOutgoingLocation } from '../messages/outgoing_location'
import { outgoingViewOnce } from '../messages/outgoing_view_once'
import type { YouTubeLinkPreviewResolver } from '../messages/youtube_link_preview'

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
  const normalizedExplicit = explicit.map(normalizeMention).filter(Boolean) as string[]
  const explicitUsers = new Set(normalizedExplicit.map((jid) => jid.split('@')[0]))
  const fromBody = Array.from(body.matchAll(/@(\d{8,20})\b/g))
    .map((match) => match[1])
    .filter((user) => !explicitUsers.has(user))
  return Array.from(new Set([...normalizedExplicit, ...fromBody.map(normalizeMention).filter(Boolean)])) as string[]
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
  options: Pick<WaSendMessageOptions, 'mentions' | 'customNodes' | 'viewOnce'>
}

const interactiveBusinessNode = {
  tag: 'biz',
  attrs: {},
  content: [{
    tag: 'interactive',
    attrs: { type: 'native_flow', v: '1' },
    content: [{
      tag: 'native_flow',
      attrs: { v: '9', name: 'mixed' },
      content: undefined,
    }],
  }],
} as const

const isPaymentButton = (button: any) =>
  button?.type === 'payment_request'
  || !!button?.payment_request
  || !!button?.payment_setting
  || !!button?.payment_settings

const orderDetailsPaymentTypes = new Set([
  'pix_dynamic_code',
  'payment_link',
  'boleto',
  'offsite_card_pay',
])

const normalizePaymentOrder = (order: any, totalAmount: any) => order && !order.tax
  ? {
      ...order,
      tax: {
        value: 0,
        offset: totalAmount?.offset || 100,
      },
    }
  : order

const nativeButton = (button: any) => {
  if (button?.type === 'order_status') {
    const parameters = button.parameters || {}
    if (!parameters.reference_id || !parameters.payment?.status) {
      throw new SendError(400, 'order_status_parameters_required')
    }
    return {
      name: 'review_order',
      buttonParamsJson: JSON.stringify(parameters),
    }
  }
  if (isPaymentButton(button)) {
    const rawPaymentRequest = button.payment_request || button
    const rawPaymentSettings = Array.isArray(rawPaymentRequest.payment_settings)
      ? rawPaymentRequest.payment_settings
      : [rawPaymentRequest.payment_setting].filter(Boolean)
    const paymentSettings = rawPaymentSettings.map((setting: any) => {
      if (setting?.type !== 'boleto' || !setting?.boleto?.digitable_line) return setting
      return {
        ...setting,
        boleto: {
          ...setting.boleto,
          digitable_line: `${setting.boleto.digitable_line}`.replace(/\D/g, ''),
        },
      }
    })
    const paymentRequest = {
      ...rawPaymentRequest,
      ...(Array.isArray(rawPaymentRequest.payment_settings) ? { payment_settings: paymentSettings } : {}),
      ...(rawPaymentRequest.payment_setting ? { payment_setting: paymentSettings[0] } : {}),
    }
    if (!paymentSettings.length) throw new SendError(400, 'payment_request_setting_required')
    const paymentTypes = paymentSettings.map((setting: any) => setting?.type)
    for (const setting of paymentSettings) {
      const paymentType = setting?.type
      if (!['pix_static_code', 'pix_dynamic_code', 'payment_link', 'boleto', 'offsite_card_pay'].includes(paymentType)) {
        throw new SendError(400, `zapo_payment_request_type_not_supported: ${paymentType || '<empty>'}`)
      }
      if (paymentType === 'pix_dynamic_code') {
        const pix = setting?.pix_dynamic_code
        if (!pix?.code || !pix?.merchant_name || !pix?.key || !pix?.key_type) {
          throw new SendError(400, 'pix_dynamic_code_fields_required')
        }
      }
      if (paymentType === 'pix_static_code') {
        const pix = setting?.pix_static_code
        if (!pix?.merchant_name || !pix?.key || !pix?.key_type) {
          throw new SendError(400, 'pix_static_code_fields_required')
        }
      }
      if (paymentType === 'payment_link' && !setting?.payment_link?.uri) {
        throw new SendError(400, 'payment_link_uri_required')
      }
      if (paymentType === 'boleto' && !setting?.boleto?.digitable_line) {
        throw new SendError(400, 'boleto_digitable_line_required')
      }
      if (
        paymentType === 'offsite_card_pay'
        && (!setting?.offsite_card_pay?.last_four_digits || !setting?.offsite_card_pay?.credential_id)
      ) {
        throw new SendError(400, 'offsite_card_pay_fields_required')
      }
    }
    const legacyOrderDetailsPaymentType = !button.order_details
      ? paymentTypes.find((type: string) => orderDetailsPaymentTypes.has(type))
      : undefined
    if (legacyOrderDetailsPaymentType && !paymentRequest.total_amount) {
      throw new SendError(400, `${legacyOrderDetailsPaymentType}_total_amount_required`)
    }
    if (button.order_details) {
      if (!paymentRequest.reference_id || !paymentRequest.currency || !paymentRequest.total_amount) {
        throw new SendError(400, 'order_details_payment_parameters_required')
      }
      const order = normalizePaymentOrder(paymentRequest.order, paymentRequest.total_amount)
      return {
        name: 'review_and_pay',
        buttonParamsJson: JSON.stringify({
          ...paymentRequest,
          ...(order ? { order } : {}),
        }),
      }
    }
    // Meta documents dynamic PIX, payment links, boleto and one-click card as
    // order_details/review_and_pay. Keep accepting the legacy Uno
    // payment_request envelope, but advertise the official native flow.
    if (legacyOrderDetailsPaymentType) {
      const order = normalizePaymentOrder(paymentRequest.order, paymentRequest.total_amount)
      return {
        name: 'review_and_pay',
        buttonParamsJson: JSON.stringify({
          reference_id: paymentRequest.reference_id || uuid(),
          type: paymentRequest.type === 'payment_request'
            ? 'physical-goods'
            : (paymentRequest.type || 'physical-goods'),
          payment_type: paymentRequest.payment_type || 'br',
          payment_settings: paymentSettings,
          currency: paymentRequest.currency || 'BRL',
          total_amount: paymentRequest.total_amount,
          ...(order ? { order } : {}),
          ...(paymentRequest.share_payment_status !== undefined
            ? { share_payment_status: paymentRequest.share_payment_status }
            : {}),
        }),
      }
    }
    const paymentParams: any = {
      currency: paymentRequest.currency || 'BRL',
      total_amount: paymentRequest.total_amount || { value: 0, offset: 100 },
      reference_id: paymentRequest.reference_id || uuid(),
      type: paymentRequest.type === 'payment_request' ? 'physical-goods' : (paymentRequest.type || 'physical-goods'),
      ...(paymentRequest.payment_type ? { payment_type: paymentRequest.payment_type } : {}),
      payment_settings: paymentSettings,
      share_payment_status: paymentRequest.share_payment_status || false,
    }
    if (paymentRequest.order) {
      paymentParams.order = paymentRequest.order
    } else {
      paymentParams.order = {
          status: 'pending',
          subtotal: { value: 0, offset: 100 },
          order_type: 'ORDER',
          items: [{ name: '', amount: { value: 0, offset: 100 }, quantity: 0, sale_amount: { value: 0, offset: 100 } }],
      }
    }
    return {
      name: 'payment_info',
      buttonParamsJson: JSON.stringify(paymentParams),
    }
  }
  if (button?.type === 'url' || button?.type === 'cta_url' || button?.url) {
    const value = button.url || button
    const url = typeof value === 'string' ? value : value.link || value.url || ''
    // Experimental client hints; forwarding them does not prove in-app rendering.
    const presentation = value.webview_presentation
    const interaction = value.webview_interaction
    if (presentation !== undefined && presentation !== 'full') throw new SendError(400, 'webview_presentation_must_be_full')
    if (interaction !== undefined && typeof interaction !== 'boolean') throw new SendError(400, 'webview_interaction_must_be_boolean')
    return { name: 'cta_url', buttonParamsJson: JSON.stringify({
      display_text: button.text || value.title || 'Abrir', url, merchant_url: value.merchant_url || url,
      ...(presentation !== undefined ? { webview_presentation: presentation } : {}),
      ...(interaction !== undefined ? { webview_interaction: interaction } : {}),
    }) }
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
  const bytes = new Uint8Array(await response.arrayBuffer())
  const uploadBytes = type === 'document'
    ? await zapoLegacyPdfNormalizer.normalizeForWhatsApp(bytes, mimetype)
    : bytes
  const [upload, processedImage] = await Promise.all([
    client.message.upload(uploadBytes, { type, mimetype }),
    type === 'image'
      ? zapoMediaProcessor.generateImageThumbnail?.(bytes, 100)
      : undefined,
  ])
  if (type === 'image' && !processedImage) {
    throw new SendError(11, 'interactive_header_thumbnail_failed')
  }
  return {
    title: `${header.text || ''}`,
    hasMediaAttachment: true,
    [`${type}Message`]: {
      ...upload,
      ...(processedImage
        ? {
            jpegThumbnail: processedImage.jpegThumbnail,
            width: processedImage.width,
            height: processedImage.height,
          }
        : {}),
      ...(media.filename ? { fileName: media.filename } : {}),
    },
  }
}

const interactiveContent = async (client: WaClient, payload: any): Promise<WaSendMessageContent> => {
  const interactive = payload?.interactive || {}
  const action = interactive.action || {}
  const isOrderDetails = interactive.type === 'order_details'
  const isOrderStatus = interactive.type === 'order_status'
  if (isOrderDetails && action.name !== 'review_and_pay') {
    throw new SendError(400, 'order_details_review_and_pay_required')
  }
  if (isOrderStatus && action.name !== 'review_order') {
    throw new SendError(400, 'order_status_review_order_required')
  }
  const actionButtons = isOrderDetails
    ? [{ type: 'payment_request', payment_request: action.parameters || {}, order_details: true }]
    : isOrderStatus
      ? [{ type: 'order_status', parameters: action.parameters || {} }]
      : (action.buttons || [])
  const body = interactive.body?.text ? { text: `${interactive.body.text}` } : undefined
  const footer = interactive.footer?.text ? { text: `${interactive.footer.text}` } : undefined
  const header = await interactiveHeader(client, interactive.header)
  if (isOrderDetails && header.hasMediaAttachment && !action.parameters?.order) {
    throw new SendError(400, 'order_details_image_requires_order')
  }
  const paymentButtons = actionButtons.filter(isPaymentButton)
  const isCommerceFlow = paymentButtons.length > 0 || isOrderStatus
  if (paymentButtons.length > 1 || (paymentButtons.length === 1 && actionButtons.length !== 1)) {
    throw new SendError(400, 'zapo_payment_request_requires_one_isolated_button')
  }

  if (Array.isArray(action.sections) && action.sections.length) {
    if (header.hasMediaAttachment) {
      throw new SendError(400, 'zapo_list_media_header_not_supported')
    }
    const sections = action.sections.map((section: any) => ({
      title: `${section?.title || ''}`,
      rows: (section?.rows || []).map((row: any) => ({
        rowId: `${row?.rowId || row?.id || ''}`,
        title: `${row?.title || ''}`,
        description: `${row?.description || ''}`,
      })),
    }))
    return {
      listMessage: {
        title: header.title,
        description: body?.text || '',
        buttonText: `${action.button || 'Selecione'}`,
        footerText: footer?.text || '',
        listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
        sections,
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

  const interactiveMessage = {
    header,
    body,
    footer,
    nativeFlowMessage: {
      buttons: actionButtons.map(nativeButton),
      messageParamsJson: isOrderStatus
        ? '{}'
        : isCommerceFlow
          ? JSON.stringify({ from: 'api', templateId: uuid() })
        : undefined,
      messageVersion: 1,
    },
  }
  // Payment flows must remain visible to companion sessions. Wrapping
  // payment_info in viewOnceMessage makes the transport advertise
  // view_once=true and recipients receive only <unavailable type="view_once"/>.
  return { interactiveMessage } as WaSendMessageContent
}

export const toZapoMessageContent = async (
  client: WaClient,
  payload: any,
  customMessageCharactersFunction: (message: string) => string = (message) => message,
  youtubeLinkPreviewResolver?: YouTubeLinkPreviewResolver,
): Promise<ZapoMappedMessage> => {
  const type = `${payload?.type || ''}`
  const viewOnce = outgoingViewOnce(payload)
  const mentions = getMentions(payload)
  if (type === 'location') {
    const { latitude, longitude, ...details } = normalizeOutgoingLocation(payload.location)
    return {
      content: { locationMessage: { degreesLatitude: latitude, degreesLongitude: longitude, ...details } },
      options: {},
    }
  }
  if (type === 'text' || type === 'message_edit') {
    const preview = normalizeAutomaticLinkPreview(
      customMessageCharactersFunction(`${payload?.text?.body || ''}`),
    )
    const youtubePreview = preview.enabled
      ? await youtubeLinkPreviewResolver?.(preview.text).catch(() => undefined)
      : undefined
    return {
      content: {
        type: 'text',
        text: preview.text,
        ...(preview.enabled ? { linkPreview: youtubePreview || true } : {}),
      },
      options: mentions.length ? { mentions } : {},
    }
  }

  if ((mediaTypes as readonly string[]).includes(type)) {
    const media = payload?.[type] || {}
    const link = `${media.link || ''}`.trim()
    if (!link) throw new SendError(11, `invalid_${type}_payload: missing link`)
    const isPtt = type === 'audio' && (SEND_AUDIO_MESSAGE_AS_PTT || media.ptt === true || payload?.ptt === true)
    const mimetype = media.mime_type || media.mimetype || getMimetype(payload) || undefined
    const resolvedMedia = await resolveMedia(type, link)
    const uploadMedia = type === 'document'
      ? await zapoLegacyPdfNormalizer.normalizeForWhatsApp(resolvedMedia, mimetype)
      : resolvedMedia
    return {
      content: {
        type,
        media: uploadMedia,
        mimetype,
        ...(isPtt ? { ptt: true } : {}),
        ...(media.caption ? { caption: customMessageCharactersFunction(media.caption) } : {}),
        ...(media.filename ? { fileName: media.filename } : {}),
      } as WaSendMessageContent,
      options: { ...(mentions.length ? { mentions } : {}), ...(viewOnce !== undefined ? { viewOnce } : {}) },
    }
  }

  if (type === 'baileys') return { content: payload.message || {}, options: {} }

  if (type === 'poll') return { content: pollContent(payload), options: {} }

  if (type === 'interactive') {
    const content = await interactiveContent(client, payload)
    const interactive = payload?.interactive || {}
    const carousel = interactive.carousel || interactive.action?.carousel
    return {
      content,
      options: {
        ...(mentions.length ? { mentions } : {}),
        ...((interactive.type === 'carousel' || carousel) ? { customNodes: [interactiveBusinessNode] } : {}),
      },
    }
  }

  if (type === 'contacts') {
    const legacyContent = toBaileysMessageContent(payload, customMessageCharactersFunction) as any
    if (legacyContent.contacts) {
      return {
        content: legacyContent.contacts.contacts.length === 1
          ? { contactMessage: legacyContent.contacts.contacts[0] }
          : { contactsArrayMessage: legacyContent.contacts },
        options: {},
      }
    }
    return { content: legacyContent, options: mentions.length ? { mentions } : {} }
  }

  throw new SendError(400, `unsupported_zapo_message_type: ${type || '<empty>'}`)
}
