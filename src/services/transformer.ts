import { AnyMessageContent, isJidNewsletter, isPnUser, isLidUser, jidNormalizedUser } from '@whiskeysockets/baileys'
import mime from 'mime-types'
import vCard from 'vcf'
import logger from './logger'
import { Config } from './config'
import { SendError } from './send_error'
import { BindTemplateError, DecryptError } from './transformer/errors'
import {
  MESSAGE_STUB_TYPE_ERRORS,
  TYPE_MESSAGES_MEDIA,
  TYPE_MESSAGES_TO_PROCESS_FILE,
  TYPE_MESSAGES_TO_READ,
} from './transformer/message_constants'
import {
  extractTypeMessage,
  getBinMessage,
  getMessageType,
  getNormalizedMessage,
  isAudioMessage,
  isSaveMedia,
  normalizeMessageContent,
} from './transformer/message_type'
import {
  ensurePn,
  formatJid,
  isIndividualJid,
  isValidPhoneNumber,
  jidToPhoneNumber,
  jidToPhoneNumberIfUser,
  jidToRawPhoneNumber,
  normalizeLidJid,
  normalizeGroupId,
  normalizeParticipantId,
  normalizeTransportJid,
  normalizeUserOrGroupIdForWebhook,
  phoneNumberToJid,
  toRawPnJid,
} from './transformer/jid'
import {
  BASE_URL,
  MESSAGE_CHECK_WAAPP,
  SEND_AUDIO_MESSAGE_AS_PTT,
  UNOAPI_DEBUG_BAILEYS_LIST_DUMP,
  UNOAPI_NATIVE_FLOW_BUTTONS,
  WEBHOOK_FORWARD_VERSION,
  WEBHOOK_PREFER_PN_OVER_LID,
  WEBHOOK_INCLUDE_MEDIA_DATA,
} from '../defaults'
import { t } from '../i18n'

export { BindTemplateError, DecryptError } from './transformer/errors'
export {
  TYPE_MESSAGES_TO_PROCESS_FILE,
  TYPE_MESSAGES_MEDIA,
  TYPE_MESSAGES_TO_READ,
} from './transformer/message_constants'
export {
  extractTypeMessage,
  getBinMessage,
  getMessageType,
  getNormalizedMessage,
  isAudioMessage,
  isSaveMedia,
  normalizeMessageContent,
} from './transformer/message_type'
export {
  ensurePn,
  formatJid,
  isIndividualJid,
  isValidPhoneNumber,
  jidToPhoneNumber,
  jidToPhoneNumberIfUser,
  jidToRawPhoneNumber,
  normalizeLidJid,
  normalizeGroupId,
  normalizeParticipantId,
  normalizeTransportJid,
  normalizeUserOrGroupIdForWebhook,
  phoneNumberToJid,
  toRawPnJid,
} from './transformer/jid'

const isViewOnceUnavailableStub = (payload: any): boolean => {
  const source = payload?.update || payload || {}
  const stubParams = Array.isArray(source?.messageStubParameters)
    ? source.messageStubParameters.map((p: any) => `${p}`)
    : []
  return stubParams.some((p: string) => p === 'view_once_unavailable' || p === 'view_once')
}

const extractFailedStatusError = (payload: any): any => {
  const update = payload?.update || {}
  const params = Array.isArray(update?.messageStubParameters)
    ? update.messageStubParameters.map((p: any) => `${p}`)
    : typeof update?.messageStubParameters !== 'undefined'
      ? [`${update.messageStubParameters}`]
      : []
  const updateErrorData = update?.error_data && typeof update.error_data === 'object' ? update.error_data : undefined
  const sourceError = update?.error || updateErrorData

  let code = sourceError?.code || update?.code || 1
  let title = sourceError?.title || update?.title || 'The Unoapi Cloud has a error, verify the logs'
  const error: any = { code, title }

  if (sourceError?.message) error.message = sourceError.message
  const errorData = update?.error?.error_data || updateErrorData
  if (errorData) error.error_data = errorData

  if (params.includes('405')) {
    error.code = 8
    error.title = 'message not allowed'
  } else if (params.includes('463')) {
    error.code = Number(sourceError?.code || update?.code || 463)
    error.title = sourceError?.title || 'Account restricted for companion or missing tctoken'
    if (!error.message && params[1]) error.message = params[1]
  }

  return error
}

const extractMessageEditInfo = (payload: any): { originalMessageId?: string; timestampMs?: string } | undefined => {
  const candidates = [
    payload?.__unoapiMessageEdit,
    payload?.message?.protocolMessage,
    payload?.message?.editedMessage?.message?.protocolMessage,
    payload?.update?.message?.protocolMessage,
    payload?.update?.message?.editedMessage?.message?.protocolMessage,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.originalMessageId) return candidate
    const isEdit = `${candidate?.type || ''}` === 'MESSAGE_EDIT' || !!candidate?.editedMessage
    const originalMessageId = `${candidate?.key?.id || ''}`.trim()
    if (isEdit && originalMessageId) {
      return {
        originalMessageId,
        timestampMs: candidate?.timestampMs ? `${candidate.timestampMs}` : undefined,
      }
    }
  }
  return undefined
}

const isSecretEncryptedMessageEdit = (message: any): boolean => {
  const secretType = `${message?.secretEncType || ''}`
  return secretType === '2' || secretType === 'MESSAGE_EDIT'
}

export const getMimetype = (payload: any) => {
  const { type } = payload
  const link = payload[type].link

  let mimetype: string | boolean = mime.lookup(link.split('?')[0])
  if (!mimetype) {
    let url
    try {
      url = new URL(link)
    } catch (error) {
      logger.error(`Error on parse url: ${link}`)
    }
    if (url) {
      mimetype = url.searchParams.get('response-content-type')
      if (!mimetype) {
        const contentDisposition = url.searchParams.get('response-content-disposition')
        if (contentDisposition) {
          const filename = contentDisposition.split('filename=')[1].split(';')[0]
          if (filename) {
            mimetype = mime.lookup(filename)
          }
        }
      }
    }
  }
  if (type == 'audio') {
    if (mimetype == 'audio/ogg') {
      mimetype = 'audio/ogg; codecs=opus'
    } else if (!mimetype) {
      mimetype = 'audio/mpeg'
    }
  }
  if (payload[type].filename) {
    if (!mimetype) {
      mimetype = mime.lookup(payload[type].filename)
    }
  }
  return mimetype ? `${mimetype}` : 'application/unknown'
}

const toArray = <T>(value: T | T[] | undefined): T[] => {
  if (Array.isArray(value)) return value
  if (value) return [value]
  return []
}

const normalizeTypeList = (raw: any): string[] => {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : `${raw}`.split(',')
  return list.map((v) => `${v}`.trim().toLowerCase()).filter(Boolean)
}

const normalizeContactName = (nameObj: any) => {
  const raw = nameObj || {}
  const first = `${raw.first_name || raw.firstName || ''}`.trim()
  const last = `${raw.last_name || raw.lastName || ''}`.trim()
  const middle = `${raw.middle_name || raw.middleName || ''}`.trim()
  const prefix = `${raw.prefix || ''}`.trim()
  const suffix = `${raw.suffix || ''}`.trim()
  let formatted = `${raw.formatted_name || raw.formattedName || raw.name || ''}`.trim()
  if (!formatted) {
    const parts = [prefix, first, middle, last, suffix].filter((p) => p)
    formatted = parts.join(' ').trim()
  }
  if (!formatted) formatted = 'Contact'
  return { formatted, first, last, middle, prefix, suffix }
}

const buildContactVcard = (contact: any): string => {
  const nameParts = normalizeContactName(contact?.name || {})
  const given = nameParts.first || (!nameParts.first && !nameParts.last ? nameParts.formatted : '')
  const family = nameParts.last || ''
  const additional = nameParts.middle || ''
  const prefix = nameParts.prefix || ''
  const suffix = nameParts.suffix || ''

  const card = new vCard()
  card.set('fn', nameParts.formatted)
  card.set('n', `${family};${given};${additional};${prefix};${suffix}`)

  const org = contact?.org || {}
  const orgParts: string[] = []
  if (org.company) orgParts.push(`${org.company}`)
  if (org.department) orgParts.push(`${org.department}`)
  if (orgParts.length) {
    card.set('org', orgParts.join(';'))
  }
  if (org.title) {
    card.set('title', `${org.title}`)
  }

  const phonesArr = Array.isArray(contact?.phones) ? contact.phones : []
  if (!phonesArr.length) throw new Error('invalid_contacts_payload: missing phones')
  let hasPhone = false
  for (const ph of phonesArr) {
    const phoneRaw = `${ph?.phone || ph?.wa_id || ''}`.trim()
    if (!phoneRaw) continue
    hasPhone = true
    const waid = `${ph?.wa_id || phoneRaw}`.replace(/\D/g, '')
    const types = normalizeTypeList(ph?.type)
    if (!types.length) types.push('cell')
    if (!types.includes('voice')) types.push('voice')
    const params: any = { type: types }
    if (waid) params.waid = waid
    card.add('tel', phoneRaw, params)
  }
  if (!hasPhone) throw new Error('invalid_contacts_payload: missing phones')

  const emailsArr = Array.isArray(contact?.emails) ? contact.emails : []
  for (const em of emailsArr) {
    const emailVal = `${em?.email || em?.address || ''}`.trim()
    if (!emailVal) continue
    const types = normalizeTypeList(em?.type)
    const params = types.length ? { type: types } : undefined
    card.add('email', emailVal, params as any)
  }

  const urlsArr = Array.isArray(contact?.urls) ? contact.urls : []
  for (const u of urlsArr) {
    const urlVal = `${u?.url || u?.link || ''}`.trim()
    if (!urlVal) continue
    const types = normalizeTypeList(u?.type)
    const params = types.length ? { type: types } : undefined
    card.add('url', urlVal, params as any)
  }

  const addrArr = Array.isArray(contact?.addresses) ? contact.addresses : []
  for (const a of addrArr) {
    const street = `${a?.street || ''}`.trim()
    const city = `${a?.city || ''}`.trim()
    const state = `${a?.state || ''}`.trim()
    const zip = `${a?.zip || ''}`.trim()
    const country = `${a?.country || ''}`.trim()
    if (!street && !city && !state && !zip && !country) continue
    const adrValue = ['', '', street, city, state, zip, country]
    const types = normalizeTypeList(a?.type)
    const params = types.length ? { type: types } : undefined
    card.add('adr', adrValue as any, params as any)
  }

  return card.toString('3.0')
}

const parseInteractiveResponse = (binMessage: any) => {
  const native = binMessage?.nativeFlowResponseMessage
  const bodyText = binMessage?.body?.text
  let params: Record<string, any> | undefined
  try {
    if (native?.paramsJson) params = JSON.parse(native.paramsJson)
  } catch {}
  const id =
    params?.id ||
    params?.button_id ||
    params?.selected_row_id ||
    params?.row_id ||
    params?.selection_id ||
    params?.list_reply_id
  const title = params?.title || params?.display_text || params?.text
  const description = params?.description
  const name = `${native?.name || ''}`.toLowerCase()
  const isList = name.includes('list') || name.includes('single_select') || !!params?.row_id || !!params?.selected_row_id
  const isButton = name.includes('quick_reply') || name.includes('button') || !!params?.button_id || !!params?.id
  return { id, title, description, isList, isButton, bodyText }
}

const parseNativeFlowSingleSelect = (buttons: any[]) => {
  const nativeButton = buttons.find((button: any) => {
    const info = button?.nativeFlowInfo
    return `${info?.name || ''}`.toLowerCase() === 'single_select'
  })
  const paramsJson =
    nativeButton?.nativeFlowInfo?.paramsJson ||
    nativeButton?.nativeFlowInfo?.buttonParamsJson
  if (!paramsJson) return undefined

  try {
    const params = JSON.parse(paramsJson)
    if (!Array.isArray(params?.sections)) return undefined
    return {
      button: params.title || 'Selecionar',
      sections: params.sections.map((section: any) => ({
        title: section?.title || '',
        rows: Array.isArray(section?.rows)
          ? section.rows.map((row: any) => ({
              id: row?.id || row?.rowId || '',
              title: row?.title || '',
              description: row?.description || '',
            }))
          : [],
      })),
    }
  } catch {
    return undefined
  }
}

const parseVcardContact = (rawVcard: string): any | undefined => {
  if (!rawVcard) return undefined
  const card: any = new vCard().parse(rawVcard.replace(/\r?\n/g, '\r\n'))
  const fn = card.get('fn')
  const n = card.get('n')
  const formatted = fn?.valueOf ? `${fn.valueOf()}`.trim() : ''
  const parts = n?.valueOf ? `${n.valueOf()}`.split(';') : []
  const last = `${parts[0] || ''}`.trim()
  const first = `${parts[1] || ''}`.trim()
  const middle = `${parts[2] || ''}`.trim()
  const prefix = `${parts[3] || ''}`.trim()
  const suffix = `${parts[4] || ''}`.trim()
  let formattedName = formatted
  if (!formattedName) {
    const nameParts = [prefix, first, middle, last, suffix].filter((p) => p)
    formattedName = nameParts.join(' ').trim()
  }
  if (!formattedName) formattedName = 'Contact'
  const name: any = { formatted_name: formattedName }
  if (first) name.first_name = first
  if (last) name.last_name = last
  if (middle) name.middle_name = middle
  if (prefix) name.prefix = prefix
  if (suffix) name.suffix = suffix

  const phones: any[] = []
  const telProps = toArray(card.get('tel'))
  for (const tel of telProps) {
    const phoneVal = tel?.valueOf ? `${tel.valueOf()}`.trim() : ''
    if (!phoneVal) continue
    const waid = tel?.waid ? `${tel.waid}`.replace(/\D/g, '') : phoneVal.replace(/\D/g, '')
    const typeRaw = tel?.type
    const type = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw
    const phoneObj: any = { phone: phoneVal }
    if (waid) phoneObj.wa_id = waid
    if (type) phoneObj.type = `${type}`.toUpperCase()
    phones.push(phoneObj)
  }

  const emails: any[] = []
  const emailProps = toArray(card.get('email'))
  for (const em of emailProps) {
    const emailVal = em?.valueOf ? `${em.valueOf()}`.trim() : ''
    if (!emailVal) continue
    const typeRaw = em?.type
    const type = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw
    const emailObj: any = { email: emailVal }
    if (type) emailObj.type = `${type}`.toUpperCase()
    emails.push(emailObj)
  }

  const urls: any[] = []
  const urlProps = toArray(card.get('url'))
  for (const u of urlProps) {
    const urlVal = u?.valueOf ? `${u.valueOf()}`.trim() : ''
    if (!urlVal) continue
    const typeRaw = u?.type
    const type = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw
    const urlObj: any = { url: urlVal }
    if (type) urlObj.type = `${type}`.toUpperCase()
    urls.push(urlObj)
  }

  const addresses: any[] = []
  const adrProps = toArray(card.get('adr'))
  for (const a of adrProps) {
    const adrVal = a?.valueOf ? `${a.valueOf()}` : ''
    const fields = adrVal.split(';')
    const street = `${fields[2] || ''}`.trim()
    const city = `${fields[3] || ''}`.trim()
    const state = `${fields[4] || ''}`.trim()
    const zip = `${fields[5] || ''}`.trim()
    const country = `${fields[6] || ''}`.trim()
    if (!street && !city && !state && !zip && !country) continue
    const typeRaw = a?.type
    const type = Array.isArray(typeRaw) ? typeRaw[0] : typeRaw
    const addrObj: any = { street, city, state, zip, country }
    if (type) addrObj.type = `${type}`.toUpperCase()
    addresses.push(addrObj)
  }

  const orgProp = card.get('org')
  const titleProp = card.get('title')
  let orgObj: any = undefined
  if (orgProp?.valueOf || titleProp?.valueOf) {
    const orgVal = orgProp?.valueOf ? `${orgProp.valueOf()}` : ''
    const orgParts = orgVal ? orgVal.split(';') : []
    const company = `${orgParts[0] || ''}`.trim()
    const department = `${orgParts[1] || ''}`.trim()
    const title = titleProp?.valueOf ? `${titleProp.valueOf()}`.trim() : ''
    orgObj = {}
    if (company) orgObj.company = company
    if (department) orgObj.department = department
    if (title) orgObj.title = title
  }

  const contact: any = { name, phones }
  if (emails.length) contact.emails = emails
  if (urls.length) contact.urls = urls
  if (addresses.length) contact.addresses = addresses
  if (orgObj && Object.keys(orgObj).length > 0) contact.org = orgObj
  return contact
}

export const completeCloudApiWebHook = (phone, to: string, message: object) => {
  return {
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
              messages: [message],
              contacts: [
                {
                  profile: {
                    name: to,
                  },
                  wa_id: to,
                },
              ],
              statuses: [],
              errors: [],
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toBaileysMessageContent = (payload: any, customMessageCharactersFunction = (m) => m): AnyMessageContent => {
  const { type } = payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = {}
  const isGroupTarget = typeof payload?.to === 'string' && payload.to.endsWith('@g.us')
  const rawTextBody = `${payload?.text?.body || ''}`
  const hasMentionAllToken = isGroupTarget && /(^|\s)@(todos|all)\b/i.test(rawTextBody)
  const bodyMentionNumbers = Array.from(
    new Set(
      Array.from(rawTextBody.matchAll(/@(\d{8,20})\b/g))
        .map((match) => `${match?.[1] || ''}`.trim())
        .filter((digits) => !!digits && isValidPhoneNumber(digits))
    )
  )
  const stripMentionAllToken = (value: string) =>
    value
      .replace(/(^|\s)@(todos|all)\b/gi, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim()
  const mentionAll = hasMentionAllToken || payload?.mentionAll === true || payload?.text?.mentionAll === true
  const rawMentions = Array.isArray(payload?.mentions)
    ? payload.mentions
    : (Array.isArray(payload?.text?.mentions) ? payload.text.mentions : [])
  const normalizeMentionToJid = (value: unknown): string => {
    const raw = `${value ?? ''}`.trim()
    if (!raw) return ''
    // Keep explicit JIDs as-is.
    if (/@(s\.whatsapp\.net|lid|hosted\.lid)$/i.test(raw)) {
      return raw
    }
    // Accept mentions in @<digits> format from UNO payloads.
    const maybeDigits = raw.startsWith('@') ? raw.slice(1) : raw
    const pn = ensurePn(maybeDigits)
    return pn ? phoneNumberToJid(pn) : ''
  }
  const mentions = [...rawMentions, ...bodyMentionNumbers]
    .map((value: unknown) => normalizeMentionToJid(value))
    .filter((value: string) => !!value)
  const mentionsUnique = Array.from(new Set(mentions))
  switch (type) {
    case 'baileys':
      return payload.message || {}

    case 'message_edit':
    case 'text':
      response.text = customMessageCharactersFunction(
        hasMentionAllToken
          ? stripMentionAllToken(rawTextBody)
          : rawTextBody
      )
      break
    case 'interactive': {
      const interactive = payload.interactive || {}
      const action = interactive.action || {}
      const header = interactive.header || {}
      const body = interactive.body || {}
      const footer = interactive.footer || {}
      const useNativeFlow = UNOAPI_NATIVE_FLOW_BUTTONS
      const mapButtonsToNativeFlow = (buttons: any[]) =>
        (buttons || [])
          .map((button: any) => {
            if (button.type === 'url' || button.url) {
              const u = button.url || button
              return {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                  display_text: u.title || 'Abrir',
                  url: u.link || u.url,
                }),
              }
            }

            if (button.type === 'call' || button.call) {
              const c = button.call || button
              return {
                name: 'cta_call',
                buttonParamsJson: JSON.stringify({
                  display_text: c.title || 'Ligar',
                  phone_number: c.phone_number || c.phone,
                }),
              }
            }

            if (button.type === 'cta_copy' || button.copy_code) {
              const cp = button.copy_code || button
              return {
                name: 'cta_copy',
                buttonParamsJson: JSON.stringify({
                  display_text: cp.title || 'Copiar',
                  copy_code: cp.code || cp.copy_code,
                }),
              }
            }

            const r = button.reply || button
            return {
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                id: r.id || '',
                display_text: r.title || r.displayText || '',
              }),
            }
          })
          .filter(Boolean)

      if (header.type && header.type !== 'text') {
        const mediaType = header.type
        const mediaObj = header[mediaType] || {}
        const link = mediaObj.link || mediaObj.url
        if (link) {
          response[mediaType] = { url: link }
          if (mediaObj.filename) {
            response.fileName = mediaObj.filename
          }
          try {
            const tmpPayload: any = { type: mediaType }
            tmpPayload[mediaType] = { link }
            const mimetype = getMimetype(tmpPayload)
            if (mimetype) response.mimetype = mimetype
          } catch {}
        }
      }

      if (action.sections && Array.isArray(action.sections) && action.sections.length > 0) {
        const sections = action.sections.map((section: any) => ({
          title: section.title || '',
          rows: (section.rows || []).map((row: any) => ({
            rowId: row.rowId || row.id || '',
            id: row.id || row.rowId || '',
            title: row.title || '',
            description: row.description || '',
          })),
        }))
        if (useNativeFlow && typeof action.listType === 'undefined') {
          response.text = body.text || ''
          response.footer = footer.text || ''
          response.buttons = [
            {
              nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                  title: action.button || 'Selecione',
                  sections,
                }),
              },
              type: 2,
            },
          ]
        } else {
          response.text = body.text || ''
          response.footer = footer.text || ''
          response.title = header.text || ''
          response.buttonText = action.button || 'Selecione'
          if (typeof action.listType !== 'undefined') {
            response.listType = action.listType
          }
          response.sections = sections.map((section: any) => ({
            title: section.title,
            rows: section.rows.map((row: any) => ({
              rowId: row.rowId || row.id || '',
              title: row.title || '',
              description: row.description || '',
            })),
          }))
        }
        break
      }

      if (interactive.type === 'carousel' || interactive.carousel || action.carousel) {
        const carousel = interactive.carousel || action.carousel || {}
        const mapCardActionToButtons = (cardAction: any, cardType?: string) => {
          const name = cardAction?.name || cardType
          const params = cardAction?.parameters || cardAction?.params || {}
          if (name === 'cta_url') {
            return [
              {
                type: 'cta_url',
                url: {
                  title: params.display_text || params.title || 'Abrir',
                  link: params.url || params.link || '',
                },
              },
            ]
          }
          if (name === 'cta_call') {
            return [
              {
                type: 'cta_call',
                call: {
                  title: params.display_text || params.title || 'Ligar',
                  phone_number: params.phone_number || params.phone || '',
                },
              },
            ]
          }
          if (name === 'cta_copy') {
            return [
              {
                type: 'cta_copy',
                copy_code: {
                  title: params.display_text || params.title || 'Copiar',
                  code: params.copy_code || params.code || '',
                },
              },
            ]
          }
          return []
        }
        const mapButtonsToNativeCarousel = (buttons: any[]) =>
          (buttons || [])
            .map((button: any) => {
              if (button.type === 'url' || button.url || button.type === 'cta_url') {
                const u = button.url || button
                const url = typeof u === 'string' ? u : u.link || u.url || ''
                return {
                  type: 'url',
                  text: button.text || u.title || u.display_text || 'Abrir',
                  url,
                  merchantUrl: button.merchantUrl || u.merchant_url || url,
                }
              }
              if (button.type === 'call' || button.call || button.type === 'cta_call') {
                const c = button.call || button
                return {
                  type: 'call',
                  text: button.text || c.title || c.display_text || 'Ligar',
                  phoneNumber: c.phone_number || c.phone || c.phoneNumber || '',
                }
              }
              if (button.type === 'cta_copy' || button.copy_code || button.copy) {
                const cp = button.copy_code || button.copy || button
                return {
                  type: 'copy',
                  text: button.text || cp.title || cp.display_text || 'Copiar',
                  copyText: cp.code || cp.copy_code || cp.copyText || '',
                }
              }
              const r = button.reply || button
              return {
                type: 'reply',
                text: r.title || r.text || r.displayText || r.display_text || 'Selecionar',
                id: r.id || r.buttonId || '',
              }
            })
            .filter((button: any) => {
              if (button.type === 'url') return !!button.url
              if (button.type === 'call') return !!button.phoneNumber
              if (button.type === 'copy') return !!button.copyText
              return !!button.id
            })
        const cards = (carousel.cards || interactive.cards || action.cards || interactive?.action?.cards || []).map((card: any) => {
          const cardHeader = card.header || {}
          const cardBody = card.body || {}
          const cardFooter = card.footer || {}
          const cardButtons = card.buttons || card.action?.buttons || mapCardActionToButtons(card.action, card.type)
          const mapCardHeaderToProto = (h: any) => {
            const headerType = `${h?.type || ''}`.toLowerCase()
            const image = h?.image || {}
            const video = h?.video || {}
            const document = h?.document || {}
            const imageLink = image.link || image.url
            const videoLink = video.link || video.url
            const documentLink = document.link || document.url
            if (headerType === 'image' && imageLink) return { imageMessage: { url: imageLink } }
            if (headerType === 'video' && videoLink) return { videoMessage: { url: videoLink } }
            if (headerType === 'document' && documentLink) {
              return { documentMessage: { url: documentLink, fileName: document.filename || document.fileName } }
            }
            if (h?.text) {
              return { type: 4, title: h.text, hasMediaAttachment: false }
            }
            return undefined
          }
          const mappedHeader = mapCardHeaderToProto(cardHeader)
          const mappedButtons = mapButtonsToNativeFlow(cardButtons)
          return {
            ...(mappedHeader ? { header: mappedHeader } : {}),
            body: { text: cardBody?.text || '' },
            ...(cardFooter?.text ? { footer: { text: cardFooter.text } } : {}),
            nativeFlowMessage: {
              buttons: mappedButtons,
            },
          }
        })
        const nativeCards = (carousel.cards || interactive.cards || action.cards || interactive?.action?.cards || []).map((card: any) => {
          const cardHeader = card.header || {}
          const cardBody = card.body || {}
          const cardFooter = card.footer || {}
          const cardButtons = card.buttons || card.action?.buttons || mapCardActionToButtons(card.action, card.type)
          const headerType = `${cardHeader?.type || ''}`.toLowerCase()
          const imageLink = cardHeader?.image?.link || cardHeader?.image?.url
          const videoLink = cardHeader?.video?.link || cardHeader?.video?.url
          return {
            title: cardHeader?.text || card.title || '',
            body: cardBody?.text || card.text || card.caption || '',
            ...(cardFooter?.text ? { footer: cardFooter.text } : {}),
            ...(headerType === 'image' && imageLink ? { image: { url: imageLink } } : {}),
            ...(headerType === 'video' && videoLink ? { video: { url: videoLink } } : {}),
            buttons: mapButtonsToNativeCarousel(cardButtons),
          }
        })
        response.nativeCarousel = {
          text: body.text || '',
          footer: footer.text || undefined,
          title: header.text || undefined,
          cards: nativeCards,
        }
        if (UNOAPI_DEBUG_BAILEYS_LIST_DUMP) {
          logger.debug(
            'toBaileys carousel->interactive dump input=%s output=%s',
            JSON.stringify({ interactive, action, header, body, footer }),
            JSON.stringify({
              nativeCarousel: response.nativeCarousel,
              legacyInteractiveCards: cards,
            }),
          )
        }
        break
      }

      if (useNativeFlow && action.buttons && Array.isArray(action.buttons) && action.buttons.length > 0) {
        const buttons = mapButtonsToNativeFlow(action.buttons)

        response.interactiveMessage = {
          body: { text: body.text || '' },
          footer: footer.text ? { text: footer.text } : undefined,
          header: header.text
            ? {
                type: 4,
                title: header.text,
                hasMediaAttachment: false,
              }
            : undefined,
          nativeFlowMessage: {
            buttons,
          },
        }

        break
      }

      if (!useNativeFlow && action.buttons && Array.isArray(action.buttons) && action.buttons.length > 0) {
        response.text = body.text || ''
        response.footer = footer.text || ''
        response.buttons = action.buttons.map((button: any) => {
          if (button.type === 'url' || button.url) {
            const u = button.url || button
            return {
              buttonId: u.link || u.url,
              buttonText: { displayText: u.title || 'Abrir link' },
              type: 1,
            }
          }

          if (button.type === 'call' || button.call) {
            const c = button.call || button
            return {
              buttonId: `call:${c.phone_number || c.phone}`,
              buttonText: { displayText: c.title || 'Ligar' },
              type: 1,
            }
          }

          const r = button.reply || button
          return {
            buttonId: r.id || r.buttonId || '',
            buttonText: {
              displayText: r.title || r.displayText || '',
            },
            type: 1,
          }
        })
        break
      }
      break
    }
    case 'sticker': {
      const media: any = (payload && payload[type]) || {}
      const link: string = (media?.link || '').toString()
      if (!link || !link.trim()) {
        throw new SendError(11, `invalid_${type}_payload: missing link`)
      }
      let mimetype: string = getMimetype(payload)
      if (mimetype) {
        response.mimetype = mimetype
      }
      response[type] = { url: link }
      break
    }
    case 'image':
    case 'audio':
    case 'document':
    case 'video': {
      // Require a valid link; do not fall-through to next case on invalid media
      const media: any = (payload && payload[type]) || {}
      const link: string = (media?.link || '').toString()
      if (!link || !link.trim()) {
        // Tratar como erro de envio "recuperável" para que o chamador
        // converta em status failed ao invés de lançar e reencaminhar a fila
        throw new SendError(11, `invalid_${type}_payload: missing link`)
      }
      let mimetype: string = getMimetype(payload)
      if (type == 'audio' && SEND_AUDIO_MESSAGE_AS_PTT) {
        response.ptt = true
      }
      if (media.filename) {
        response.fileName = media.filename
      }
      if (mimetype) {
        response.mimetype = mimetype
      }
      if (media.caption) {
        response.caption = customMessageCharactersFunction(media.caption)
      }
      response[type] = { url: link }
      break
    }

    case 'contacts': {
      const list: any[] = Array.isArray(payload?.[type]) ? payload[type] : []
      if (!list.length) throw new Error('invalid_contacts_payload: empty list')
      const contacts: any[] = []
      for (const entry of list) {
        const vcard = buildContactVcard(entry)
        const displayName = normalizeContactName(entry?.name || {}).formatted
        contacts.push({ displayName, vcard })
      }
      const first = list[0] || {}
      const nameObj = first?.name || {}
      const contactName = normalizeContactName(nameObj).formatted
      const displayName = contacts.length > 1 ? `${contacts.length} contacts` : contactName
      response[type] = { displayName, contacts }
      break
    }

    case 'template':
      throw new BindTemplateError()

    default:
      throw new Error(`Unknow message type ${type}`)
  }
  if (mentionsUnique.length && !mentionAll) {
    response.mentions = mentionsUnique
  }
  if (mentionAll) {
    response.mentionAll = true
  }
  try {
    if (type === 'text' || mentionsUnique.length || mentionAll || hasMentionAllToken) {
      const outText = `${(response as any)?.text || ''}`
      logger.info(
        'MENTION_OUT to=%s type=%s isGroup=%s hasToken=%s mentionAll=%s rawMentions=%s bodyMentions=%s finalMentions=%s inText="%s" outText="%s"',
        `${payload?.to || '<none>'}`,
        `${type || '<none>'}`,
        isGroupTarget,
        hasMentionAllToken,
        mentionAll,
        JSON.stringify(rawMentions || []),
        JSON.stringify(bodyMentionNumbers || []),
        JSON.stringify(mentionsUnique || []),
        rawTextBody.slice(0, 200),
        outText.slice(0, 200),
      )
    }
  } catch {}
  return response
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isIndividualMessage = (payload: any) => {
  const {
    key: { remoteJid },
  } = payload
  return isIndividualJid(remoteJid)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getChatAndNumberAndId = (payload: any): [string, string, string] => {
  const { key: { remoteJid } } = payload
  const split = remoteJid.split('@')
  const id = `${split[0].split(':')[0]}@${split[1]}`
  // Para LID (usuário @lid), preferimos derivar o PN a partir dos campos *_Pn via getNumberAndId
  // Assim, o segundo retorno será o telefone (PN) normalizado, conforme esperado pelos testes
  if (isIndividualJid(remoteJid) && isPnUser(remoteJid as any)) {
    return [id, jidToPhoneNumber(remoteJid, ''), id]
  } else {
    return [id, ...getNumberAndId(payload)]
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getNumberAndId = (payload: any): [string, string] => {
  const {
    key: {
      remoteJid,
      senderPn,
      participantPn,
      participant,
      senderLid,
      participantLid,
      recipientLid,
      // Baileys >=6.8 alt JIDs
      remoteJidAlt,
      participantAlt,
    } = {},
    participant: participant2,
    participantPn: participantPn2,
    participantAlt: participantAlt2,
  } = payload || {}

  // Normalize base ID (can be PN or LID)
  const lid = senderLid || participantLid || recipientLid || participant || participant2 || remoteJid || ''
  const split = `${lid}`.split('@')
  const id = split.length >= 2 ? `${split[0].split(':')[0]}@${split[1]}` : `${lid}`

  // Prefer a PN JID if any is available (explicit PN fields or alt PN fields)
  const pnCandidate = participantPn || senderPn || participantPn2 || participant || participant2 || remoteJidAlt || participantAlt || participantAlt2
  const pnIsValid = pnCandidate && isPnUser(pnCandidate)
  let phone: string | undefined
  if (pnIsValid) {
    phone = jidToPhoneNumber(pnCandidate, '')
  } else {
    // Prefer explicit PN fields first — accept both PN JIDs and plain digits
    if (!phone && typeof participantPn === 'string') {
      if (isPnUser(participantPn as any)) {
        phone = jidToPhoneNumber(participantPn, '')
      } else if (/^\+?\d+$/.test(participantPn)) {
        // aplicar regra BR do 9º dígito como em phoneNumberToJid
        try { phone = jidToPhoneNumber(phoneNumberToJid(participantPn), '') } catch { phone = ensurePn(participantPn) }
      }
    }
    if (!phone && typeof senderPn === 'string') {
      if (isPnUser(senderPn as any)) {
        phone = jidToPhoneNumber(senderPn, '')
      } else if (/^\+?\d+$/.test(senderPn)) {
        try { phone = jidToPhoneNumber(phoneNumberToJid(senderPn), '') } catch { phone = ensurePn(senderPn) }
      }
    }
    // Then try map from group metadata participants (if present): find PN by LID
    if (!phone) {
      try {
        const participants: any[] = (payload?.groupMetadata?.participants || []) as any[]
        if (participants?.length) {
          const lidCandidate = normalizeLidJid(senderLid || participantLid || participant || participant2 || participantAlt || participantAlt2 || remoteJidAlt)
          const found = participants.find((p: any) => normalizeLidJid(p?.lid || p?.jid || p?.id) === lidCandidate)
          const pnFromGroup = found?.id || found?.jid
          if (pnFromGroup && isPnUser(pnFromGroup)) {
            phone = jidToPhoneNumber(pnFromGroup, '')
          }
        }
      } catch {}
    }
    // Last resort: normalize the base id (may be LID) and extract PN
    if (!phone) {
      try {
        if (isPnUser(id)) {
          phone = jidToPhoneNumber(id, '')
        } else {
          // keep id (may be LID JID) when PN cannot be safely inferred
          phone = id
        }
      } catch {
        phone = id
      }
    }
  }
  return [phone!, id]
}

const firstNonEmptyString = (...values: any[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

const normalizeLidUserId = (value?: string): string | undefined => {
  if (!value || typeof value !== 'string') return undefined
  try {
    const jid = normalizeLidJid(value) || (value.includes('@') ? formatJid(value) : value)
    return isLidUser(jid as any) ? jid : undefined
  } catch {
    return normalizeLidJid(value) || (value.endsWith('@lid') ? value : undefined)
  }
}

const extractBaileysStableUserId = (payload: any, senderId?: string): string | undefined => {
  const key = payload?.key || {}
  return firstNonEmptyString(
    normalizeLidUserId(key.senderLid),
    normalizeLidUserId(key.participantLid),
    normalizeLidUserId(key.recipientLid),
    normalizeLidUserId(key.participant),
    normalizeLidUserId(payload?.participant),
    normalizeLidUserId(key.remoteJid),
    normalizeLidUserId(senderId),
  )
}

const extractBaileysUsername = (payload: any): string | undefined => {
  const key = payload?.key || {}
  return firstNonEmptyString(
    key.participantUsername,
    key.remoteJidUsername,
    key.senderUsername,
    payload?.participantUsername,
    payload?.remoteJidUsername,
    payload?.senderUsername,
    payload?.contact?.username,
    payload?.username,
  )
}

export const extractDestinyPhone = (payload: object, throwError = true) => {
  const data = payload as any
  let number = data?.to || (
    (
      data?.entry
      && data.entry[0]
      && data.entry[0].changes
      && data.entry[0].changes[0]
      && data.entry[0].changes[0].value
    ) && (
      (
        data.entry[0].changes[0].value.contacts
        && data.entry[0].changes[0].value.contacts[0]
        && data.entry[0].changes[0].value.contacts[0].wa_id?.replace('+', '')
      ) || (
        data.entry[0].changes[0].value.statuses
        && data.entry[0].changes[0].value.statuses[0]
        && data.entry[0].changes[0].value.statuses[0].recipient_id?.replace('+', '')
      )
    )
  )
  // Normalize JIDs (LID/PN) to plain phone when possible
  try {
    if (
      typeof number === 'string' &&
      (
        number.endsWith('@s.whatsapp.net') ||
        number.endsWith('@lid') ||
        number.endsWith('@g.us') ||
        number.endsWith('@newsletter')
      )
    ) {
      // Prefer a normalized PN JID, then extract phone if it's an individual user
      const normalizedJid = jidNormalizedUser(number)
      number = jidToPhoneNumberIfUser(normalizedJid).replace('+', '')
    }
  } catch {}
  if (!number && throwError) {
    throw Error(`error on get phone number from ${JSON.stringify(payload)}`)
  }
  return number
}
export const extractFromPhone = (payload: object, throwError = true) => {
  const data = payload as any
  const number =
    data?.entry
    && data.entry[0]
    && data.entry[0].changes
    && data.entry[0].changes[0]
    && data.entry[0].changes[0].value
    && data.entry[0].changes[0].value.messages
    && data.entry[0].changes[0].value.messages[0]
    && data.entry[0].changes[0].value.messages[0].from?.replace('+', '')
  if (!number && throwError) {
    throw Error(`error on get phone number from ${JSON.stringify(payload)}`)
  }
  return number
}

export const getGroupId = (payload: object) => {
  const data = payload as any
  return (
      data.entry
      && data.entry[0]
      && data.entry[0].changes
      && data.entry[0].changes[0]
      && data.entry[0].changes[0].value
    ) && (
      (
        data.entry[0].changes[0].value.contacts
        && data.entry[0].changes[0].value.contacts[0]
        && data.entry[0].changes[0].value.contacts[0].group_id
      )
      || (
        data.entry[0].changes[0].value.messages
        && data.entry[0].changes[0].value.messages[0]
        && data.entry[0].changes[0].value.messages[0].group_id
      )
    )
}

export const isGroupMessage = (payload: object) => {
  return !!getGroupId(payload)
}

export const isNewsletterMessage = (payload: object) => {
  const groupId = getGroupId(payload)
  return groupId && isJidNewsletter(groupId)
}

export const extractSessionPhone  = (payload: object) => {
  const data = payload as any
  const session = data.entry
                && data.entry[0]
                && data.entry[0].changes 
                && data.entry[0].changes[0].value.messages
                && data.entry[0].changes[0].value.metadata
                && data.entry[0].changes[0].value.metadata.display_phone_number

  return `${(session || '')}`.replaceAll('+', '')
}

export const isOutgoingMessage = (payload: object) => {
  const from = extractFromPhone(payload, false)
  const session = extractSessionPhone(payload)
  return session && from && session == from
}

export const isUpdateMessage = (payload: object) => {
  const data = payload as any
  return data.entry[0].changes[0].value.statuses && data.entry[0].changes[0].value.statuses[0]
}

export const isIncomingMessage = (payload: object) => {
  return !isOutgoingMessage(payload)
}

export const isFailedStatus = (payload: object) => {
  const data = payload as any
  return 'failed' == (data.entry[0].changes[0].value.statuses
                        && data.entry[0].changes[0].value.statuses[0]
                        && data.entry[0].changes[0].value.statuses[0].status)
}

// Aplica normalização nos campos de IDs do payload Cloud API pronto para envio
// - contacts[*].wa_id
// - contacts[*].user_id
// - messages[*].from
// - messages[*].from_user_id
// - statuses[*].recipient_id
export const normalizeWebhookValueIds = (cloudValue: any): void => {
  try {
    const v: any = cloudValue || {}
    if (Array.isArray(v.contacts)) {
      for (const c of v.contacts) {
        if (c && typeof c.wa_id === 'string') c.wa_id = normalizeUserOrGroupIdForWebhook(c.wa_id)
        if (c && typeof c.user_id === 'string') c.user_id = normalizeLidJid(c.user_id) || c.user_id
      }
    }
    if (Array.isArray(v.messages)) {
      for (const m of v.messages) {
        if (m && typeof m.from === 'string') m.from = normalizeUserOrGroupIdForWebhook(m.from)
        if (m && typeof m.from_user_id === 'string') m.from_user_id = normalizeLidJid(m.from_user_id) || m.from_user_id
      }
    }
    if (Array.isArray(v.statuses)) {
      for (const s of v.statuses) {
        if (s && typeof s.recipient_id === 'string') s.recipient_id = normalizeUserOrGroupIdForWebhook(s.recipient_id)
      }
    }
  } catch {}
}

/*
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WHATSAPP-BUSINESS-ACCOUNT-ID",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "PHONE-NUMBER",
          "phone_number_id": "PHONE-NUMBER-ID"
        },
      # Additional arrays and objects
        "contacts": [{...}]
        "errors": [{...}]
        "messages": [{...}]
        "statuses": [{...}]
      },
      "field": "messages"

    }]
  }]
}

{
  "key": {
   "remoteJid": "554999379224@s.whatsapp.net",
   "fromMe": true,
   "id": "BAE55FF6705AD8DD"
  },
  "update": {
   "status": 0,
   "messageStubParameters": [
    "405"
   ]
  }
 }
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fromBaileysMessageContent = (phone: string, payload: any, config?: Partial<Config>): [any, string, string] => {
  try {
    const { key: { id: whatsappMessageId, fromMe } } = payload
    const [chatJid, senderPhone, senderId] = getChatAndNumberAndId(payload)
    const messageType = getMessageType(payload)
    const messageEditInfo = extractMessageEditInfo(payload)
    // Device-sent messages (from the phone) may arrive under messages.update with message content.
    // Unwrap to a plain message payload and DROP the update field to avoid recursion.
    const innerUpdateMsg = payload?.update?.message?.deviceSentMessage?.message || payload?.update?.message
    if (innerUpdateMsg) {
      const keys = Object.keys(innerUpdateMsg || {})
      const hasReadable = keys.find((k) => TYPE_MESSAGES_TO_READ.includes(k) || k === 'protocolMessage' || k === 'editedMessage')
      if (hasReadable) {
        const { update: _omit, ...rest } = payload
        const changedPayload = { ...rest, message: innerUpdateMsg, __unoapiMessageEdit: messageEditInfo }
        return fromBaileysMessageContent(phone, changedPayload, config)
      }
    }
    // Unwrap device-sent messages (from companion) to inner message
    const innerDeviceMsg = payload?.message?.deviceSentMessage?.message
    if (innerDeviceMsg) {
      const { update: _omitDev, ...restDev } = payload || {}
      const changedPayload = { ...restDev, message: innerDeviceMsg, __unoapiMessageEdit: messageEditInfo }
      return fromBaileysMessageContent(phone, changedPayload, config)
    }
    // Also unwrap editedMessage wrappers into their inner original message content
    let innerEditedMsg = payload?.message?.editedMessage?.message || payload?.message?.protocolMessage?.editedMessage?.message
    if (innerEditedMsg) {
      // If inner edited content is a media without url but with caption, convert to text(conversation: caption)
      try {
        const tmp: any = { message: innerEditedMsg }
        const t = getMessageType(tmp)
        const b = getBinMessage(tmp as any)
        if (t && TYPE_MESSAGES_TO_PROCESS_FILE.includes(t) && !b?.message?.url && b?.message?.caption) {
          innerEditedMsg = { conversation: b.message.caption } as any
        } else if (['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage','lottieStickerMessage'].includes(`${t}`)) {
          const inner = (b as any)?.message?.message || (b as any)?.message
          if (inner && typeof inner === 'object') {
            const keys = Object.keys(inner || {})
            const innerType = keys.find((k) => TYPE_MESSAGES_TO_PROCESS_FILE.includes(k))
            if (innerType) {
              const innerMsg = (inner as any)[innerType]
              if (innerMsg && !innerMsg.url && innerMsg.caption) {
                innerEditedMsg = { conversation: innerMsg.caption } as any
              }
            }
          }
        } else if (`${t}` === 'protocolMessage') {
          const em = (b as any)?.message?.editedMessage
          if (em && typeof em === 'object') {
            const keys = Object.keys(em || {})
            const mkey = keys.find((k) => TYPE_MESSAGES_TO_PROCESS_FILE.includes(k))
            if (mkey) {
              const innerMsg = (em as any)[mkey]
              if (innerMsg && !innerMsg.url && innerMsg.caption) {
                innerEditedMsg = { conversation: innerMsg.caption } as any
              }
            }
          }
        }
      } catch {}
      const { update: _omitEdit, ...restEdit } = payload || {}
      const changedPayload = { ...restEdit, message: innerEditedMsg, __unoapiMessageEdit: messageEditInfo }
      return fromBaileysMessageContent(phone, changedPayload, config)
    }
    const binMessage = payload.update || payload.receipt || (messageType && payload.message && payload.message[messageType])
    const senderStableUserId = extractBaileysStableUserId(payload, senderId)
    const senderUsername = extractBaileysUsername(payload)
    const contactWaId = (
      // 1) outro lado (derivado do remoteJid já normalizado)
      ensurePn(senderPhone) ||
      // 2) alternativas explícitas quando presentes
      ensurePn(payload?.key?.participantPn) ||
      ensurePn(payload?.participantPn) ||
      ensurePn(payload?.key?.senderPn) ||
      // 3) fallbacks a partir de JIDs brutos
      ensurePn(senderId) ||
      ensurePn(payload?.key?.remoteJid) ||
      ensurePn(payload?.key?.remoteJidAlt) ||
      ensurePn(payload?.key?.participantAlt) ||
      ensurePn(payload?.participantAlt)
    ) || ''
    let profileName
    if (fromMe) {
      profileName = firstNonEmptyString(senderPhone, contactWaId, senderStableUserId)
    } else {
      profileName = firstNonEmptyString(payload.verifiedBizName, payload.pushName, senderUsername, contactWaId, senderStableUserId)
    }
    let cloudApiStatus
    let cloudApiStatusMessageId = whatsappMessageId
    let messageTimestamp = payload.messageTimestamp
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groupMetadata: any = {}
    if (typeof chatJid === 'string' && chatJid.endsWith('@g.us')) {
      groupMetadata.group_id = chatJid
    }
    if (payload.groupMetadata) {
      if (payload.groupMetadata.subject) groupMetadata.group_subject = payload.groupMetadata.subject
      if (payload.groupMetadata.profilePicture) groupMetadata.group_picture = payload.groupMetadata.profilePicture
      if (payload.groupMetadata.profilePictureMetadata) groupMetadata.group_picture_metadata = payload.groupMetadata.profilePictureMetadata
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statuses: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors: any[] = []
    const change = {
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: phone,
          phone_number_id: phone,
        },
        messages,
        contacts: [
          {
            profile: (
              () => {
                // Em eventos de status (update/receipt), nao incluir picture
                const p: any = { name: profileName }
                if (senderUsername) p.username = senderUsername
                const mt = `${messageType || ''}`
                if (!['update', 'receipt'].includes(mt)) {
                  const pic = payload.profilePicture
                  if (typeof pic === 'string' && pic) {
                    p.picture = pic
                  }
                  if (payload.profilePictureMetadata) {
                    p.picture_metadata = payload.profilePictureMetadata
                  }
                }
                return p
              }
            )(),
            ...groupMetadata,
            wa_id: contactWaId,
            ...(senderStableUserId ? { user_id: senderStableUserId } : {}),
          },
        ],
        statuses,
        errors,
      },
      field: 'messages',
    }
  const data = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phone,
          changes: [change],
        },
      ],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message: any = {
      from: undefined as any,
      id: whatsappMessageId,
    }
    const emitViewOnceUnavailableMessage = () => {
      const k: any = (payload as any)?.key || {}
      message.type = 'text'
      message.text = {
        body: 'Mídia de visualização única indisponível neste dispositivo.',
      }
      logger.info('view_once_unavailable detected msgId=%s remoteJid=%s fromMe=%s hasMediaKey=%s hasDirectPath=%s reason=%s',
        k?.id || whatsappMessageId || '<none>',
        k?.remoteJid || '<none>',
        !!k?.fromMe,
        false,
        false,
        'server_delivered_unavailable_placeholder',
      )
      change.value.messages.push(message)
      return [data, senderPhone, senderId] as [any, string, string]
    }
    if (senderStableUserId && !fromMe) {
      message.from_user_id = senderStableUserId
    }
    if (groupMetadata.group_id) {
      message.group_id = normalizeGroupId(groupMetadata.group_id)
    }
    // Build 'from' prioritizing PN; when not possible, keep it empty and expose LID in from_user_id.
    try {
      if (fromMe) {
        message.from = phone.replace('+', '')
      } else {
        const fpn = (
          ensurePn((payload as any)?.key?.senderPn) ||
          ensurePn((payload as any)?.key?.participantPn) ||
          ensurePn(senderPhone) ||
          ensurePn(senderId)
        )
        if (fpn) {
          message.from = fpn
        } else {
          message.from = ''
        }
      }
    } catch {
      message.from = fromMe ? phone.replace('+', '') : ''
    }
    if (payload.messageTimestamp) {
      message['timestamp'] = payload.messageTimestamp.toString()
    }
    switch (messageType) {
      case 'imageMessage':
      case 'videoMessage':
      case 'audioMessage':
      case 'stickerMessage':
      case 'documentMessage':
      case 'ptvMessage':
        let mediaType = messageType.replace('Message', '')
        const mediaKey = `${phone}/${whatsappMessageId}`
        // Be defensive: edited/device-sent updates may omit mimetype/url
        const rawMime = ((binMessage && (binMessage as any).fileName) && (mime.lookup((binMessage as any).fileName) as string))
                      || (binMessage && (binMessage as any).mimetype) || ''
        const mimetype = (rawMime && rawMime.split(';')[0]) || 'application/octet-stream'
        const extension = (mime.extension(mimetype) || 'bin') as string
        const filename = (binMessage && (binMessage as any).fileName) || `${whatsappMessageId}.${extension}`
        const encodedFilename = encodeURIComponent(filename)
        const cleanBaseUrl = `${BASE_URL || ''}`.replace(/\/+$/, '')
        const cleanVersion = `${WEBHOOK_FORWARD_VERSION || ''}`.replace(/^\/+|\/+$/g, '')
        const mediaUrlRaw: string | undefined = (binMessage && (binMessage as any).url) || undefined
        const mediaUrl = (() => {
          const u = `${mediaUrlRaw || ''}`
          if (!u) return ''
          if (u.startsWith('data:')) return ''
          return u
        })()
        const downloadUrl = mediaUrl || `${cleanBaseUrl}/${cleanVersion}/download/${phone}/${encodedFilename}`
        if (mediaType == 'pvt') {
          mediaType = mimetype.split('/')[0]
        }
        const normalizeSha256 = (v: any): string | undefined => {
          try {
            if (!v) return undefined
            if (typeof v === 'string') return v
            if (v?.type === 'Buffer' && Array.isArray(v?.data)) {
              return Buffer.from(v.data).toString('base64')
            }
            if (Array.isArray(v)) {
              return Buffer.from(v as any).toString('base64')
            }
            if (v instanceof Uint8Array) {
              return Buffer.from(v).toString('base64')
            }
          } catch {}
          return undefined
        }
        message[mediaType] = {
          caption: binMessage.caption,
          filename,
          mime_type: mimetype,
          sha256: normalizeSha256((binMessage as any)?.fileSha256),
          url: downloadUrl,
          // url: binMessage.url && binMessage.url.indexOf('base64') < 0 ? binMessage.url : '',
          id: mediaKey,
        }
        if (!WEBHOOK_INCLUDE_MEDIA_DATA && message[mediaType]) {
          delete message[mediaType].sha256
        }
        message.type = mediaType
        break

      case 'contactMessage':
      case 'contactsArrayMessage':
        // {"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3EB03CDCC2A5D40DEFED"},"messageTimestamp":1676629371,"pushName":"Clairton Rodrigo Heinzen","message":{"contactsArrayMessage":{"contacts":[{"displayName":"Adapta","vcard":"BEGIN:VCARD\nVERSION:3.0\nN:;Adapta;;;\nFN:Adapta\nTEL;type=CELL;waid=554988333030:+55 49 8833-3030\nEND:VCARD"},{"displayName":"Silvia Castagna Heinzen","vcard":"BEGIN:VCARD\nVERSION:3.0\nN:Castagna Heinzen;Silvia;;;\nFN:Silvia Castagna Heinzen\nTEL;type=CELL;waid=554999621461:+55 49 9962-1461\nEND:VCARD"}],"contextInfo":{"disappearingMode":{"initiator":"CHANGED_IN_CHAT"}}},"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"DSu3J5WUK+vicA==","senderTimestamp":"1676571145","recipientKeyHash":"tz8qTGvqyPjOUw==","recipientTimestamp":"1666725555"},"deviceListMetadataVersion":2}}}}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vcards = messageType == 'contactMessage' ? [binMessage.vcard] : binMessage.contacts.map((c: any) => c.vcard)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contacts: any[] = []
        for (let i = 0; i < vcards.length; i++) {
          const vcard = vcards[i]
          if (vcard) {
            const contact = parseVcardContact(vcard)
            if (contact) contacts.push(contact)
          }
        }
        message.contacts = contacts
        message.type = 'contacts'
        break

      case 'editedMessage':
        // {"key":{"remoteJid":"120363193643042227@g.us","fromMe":false,"id":"3EB06C161FED2A9D63C767","participant":"554988290955@s.whatsapp.net"},"messageTimestamp":1698278099,"pushName":"Clairton Rodrigo Heinzen","broadcast":false,"message":{"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"ltZ5vMXiILth5A==","senderTimestamp":"1697942459","recipientKeyHash":"GVXxipL53tKc2g==","recipientTimestamp":"1697053156"},"deviceListMetadataVersion":2},"editedMessage":{"message":{"protocolMessage":{"key":{"remoteJid":"120363193643042227@g.us","fromMe":true,"id":"3EB03E16AD6F36BFCDD9F5","participant":"554988290955@s.whatsapp.net"},"type":"MESSAGE_EDIT","editedMessage":{"conversation":"Kailaine, reagenda esse pacientes da dra Eloisa que estão em dias diferentes da terça e quinta\\nQuando tiver concluido me avisa para fechar a agendar, pois foi esquecido de fechar a agenda"},"timestampMs":"1698278096189"}}}}}
        // {"key":{"remoteJid":"X@s.whatsapp.net","fromMe":false,"id":"X"},"messageTimestamp":1742222988,"pushName":"X","message":{"editedMessage":{"message":{"conversation":"Bom dia, tudo bem?"}}},"verifiedBizName":"X"}
        const editedMessage = binMessage.message.protocolMessage ? binMessage.message.protocolMessage[messageType] : binMessage.message
        // Keep envelope key.id (Cloud API expects current event id), only replace message content
        const { update: _omitUpdate1, ...restEdited } = payload || {}
        const editedMessagePayload: any = { ...restEdited, message: editedMessage, __unoapiMessageEdit: messageEditInfo }
        const editedMessageType = getMessageType(editedMessagePayload)
        const editedBinMessage = getBinMessage(editedMessagePayload)
        if (editedMessageType && TYPE_MESSAGES_TO_PROCESS_FILE.includes(editedMessageType) && !editedBinMessage?.message?.url && editedBinMessage?.message?.caption) {
          editedMessagePayload.message = { conversation: editedBinMessage?.message?.caption }
        } else if (['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage','lottieStickerMessage'].includes(`${editedMessageType}`)) {
          const inner = (editedBinMessage as any)?.message?.message || (editedBinMessage as any)?.message
          if (inner && typeof inner === 'object') {
            const keys = Object.keys(inner || {})
            const innerType = keys.find((k) => TYPE_MESSAGES_TO_PROCESS_FILE.includes(k))
            if (innerType) {
              const innerMsg = (inner as any)[innerType]
              if (innerMsg && !innerMsg.url && innerMsg.caption) {
                editedMessagePayload.message = { conversation: innerMsg.caption }
              }
            }
          }
        }
        return fromBaileysMessageContent(phone, editedMessagePayload, config)

      
      case 'protocolMessage':
        // {"key":{"remoteJid":"351912490567@s.whatsapp.net","fromMe":false,"id":"3EB0C77FBE5C8DACBEC5"},"messageTimestamp":1741714271,"pushName":"Pedro Paiva","broadcast":false,"message":{"protocolMessage":{"key":{"remoteJid":"351211450051@s.whatsapp.net","fromMe":true,"id":"3EB05C0B7B1A0C12284EE0"},"type":"MESSAGE_EDIT","editedMessage":{"conversation":"blablabla2","messageContextInfo":{"messageSecret":"4RYW9eIV1O4j5vjNmY059bZRymJ+B2aTfi9it9+2RxA="}},"timestampMs":"1741714271693"},"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"UgdPt0CEKvqhyg==","senderTimestamp":"1741018303","senderAccountType":"E2EE","receiverAccountType":"E2EE","recipientKeyHash":"EhuHta8R2tH+8g==","recipientTimestamp":"1740522549"},"deviceListMetadataVersion":2,"messageSecret":"4RYW9eIV1O4j5vjNmY059bZRymJ+B2aTfi9it9+2RxA="}}}
        if (binMessage.editedMessage) {
          // Unwrap into the inner edited content and drop any update field to avoid recursion
          let inner = (binMessage.editedMessage as any)?.message
            || ((binMessage.editedMessage as any)?.conversation ? { conversation: (binMessage.editedMessage as any).conversation } : undefined)
            || (binMessage.editedMessage as any)
          try {
            if (inner && typeof inner === 'object') {
              const keys = Object.keys(inner || {})
              const innerType = keys.find((k) => TYPE_MESSAGES_TO_PROCESS_FILE.includes(k))
              if (innerType) {
                const innerMsg = (inner as any)[innerType]
                if (innerMsg && !innerMsg.url && innerMsg.caption) {
                  inner = { conversation: innerMsg.caption } as any
                }
              }
            }
          } catch {}
          const { update: _omitUpdate2, ...restProto } = payload || {}
          return fromBaileysMessageContent(phone, { ...restProto, message: inner, __unoapiMessageEdit: messageEditInfo }, config)
        } else {
          const protocolType = typeof binMessage?.type === 'undefined' ? '' : `${binMessage.type}`
          const revokedMessageId = `${binMessage?.key?.id || ''}`.trim()
          if ((protocolType === 'REVOKE' || protocolType === '0') && revokedMessageId) {
            cloudApiStatus = 'deleted'
            cloudApiStatusMessageId = revokedMessageId
            break
          }
          logger.debug(`Ignore message type ${messageType}`)
          return [null, senderPhone, senderId]
        }

      case 'secretEncryptedMessage':
        if (isSecretEncryptedMessageEdit(binMessage)) {
          const targetId = `${(binMessage as any)?.targetMessageKey?.id || messageEditInfo?.originalMessageId || ''}`.trim()
          logger.info(
            'Ignore encrypted message edit until decrypted content is available: eventId=%s targetId=%s',
            whatsappMessageId || '<none>',
            targetId || '<none>',
          )
          return [null, senderPhone, senderId]
        }
        logger.debug(`Ignore message type ${messageType}`)
        return [null, senderPhone, senderId]

      case 'ephemeralMessage':
      case 'viewOnceMessage':
      case 'viewOnceMessageV2':
      // {"key":{"remoteJid":"554891710539@s.whatsapp.net","fromMe":false,"id":"3EB016D7881A2C29E25378"},"messageTimestamp":1704301811,"pushName":"Rodrigo","broadcast":false,"message":{"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"n3DiVMM5RFh8Cg==","senderTimestamp":"1703800265","recipientKeyHash":"5IqwqCOTqgXgCA==","recipientTimestamp":"1704205568"},"deviceListMetadataVersion":2},"documentWithCaptionMessage":{"message":{"documentMessage":{"url":"https://mmg.whatsapp.net/v/t62.7119-24/24248058_881769707068106_5138895532383847851_n.enc?ccb=11-4&oh=01_AdQM6YlfR3dW_UvRoLmPQeqOl08pdn8DNtTCTP1DMz4gcA&oe=65BCEDEA&_nc_sid=5e03e0&mms3=true","mimetype":"text/csv","title":"Clientes-03-01-2024-11-38-32.csv","fileSha256":"dmBD4FB1aoDA9fnIRXbvqgExKmxqK6qjGFIGETMmH4Y=","fileLength":"266154","mediaKey":"Mmu+1SthUQuVn8JM+W1Uwttkb3Vo/VQlSJQd/ddNixU=","fileName":"Clientes-03-01-2024-11-38-32.csv","fileEncSha256":"+EadJ+TTn43nOvcccdXAdHSYt9KQy+R7lcsmwkotQnY=","directPath":"/v/t62.7119-24/24248058_881769707068106_5138895532383847851_n.enc?ccb=11-4&oh=01_AdQM6YlfR3dW_UvRoLmPQeqOl08pdn8DNtTCTP1DMz4gcA&oe=65BCEDEA&_nc_sid=5e03e0","mediaKeyTimestamp":"1704301417","contactVcard":false,"contextInfo":{"ephemeralSettingTimestamp":"1702988379","disappearingMode":{"initiator":"CHANGED_IN_CHAT"}},"caption":"pode subir essa campanha por favor"}}}}}
      case 'documentWithCaptionMessage':
      case 'lottieStickerMessage':
      // {"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3A3BD07D3529A482876A"},"messageTimestamp":1726448401,"pushName":"Clairton Rodrigo Heinzen","broadcast":false,"message":{"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"FxWbzja6L9qr6A==","senderTimestamp":"1725477022","recipientKeyHash":"HDhq+OTRdd9hhg==","recipientTimestamp":"1725986929"},"deviceListMetadataVersion":2},"viewOnceMessageV2Extension":{"message":{"audioMessage":{"url":"https://mmg.whatsapp.net/v/t62.7117-24/26550443_409309922183140_5545513783776136395_n.enc?ccb=11-4&oh=01_Q5AaIFdNmgUqP86I5VM6WLnt4i1h6wxOoPGY2kvj7wQlhE4c&oe=670EF9DE&_nc_sid=5e03e0&mms3=true","mimetype":"audio/ogg; codecs=opus","fileSha256":"kIFwwAF/PlmPp/Lxy2lVKgt8aq+fzSe+XmRwT5/Cn5A=","fileLength":"11339","seconds":8,"ptt":true,"mediaKey":"MEOnPR/10pkdQhNjjoB1yJXOZ/x9XAJk0m1XI1g7tdM=","fileEncSha256":"ZS1J1Zkjd93jz8TVg9rlNSotMCVbbZyBR/lOIwQhkSI=","directPath":"/v/t62.7117-24/26550443_409309922183140_5545513783776136395_n.enc?ccb=11-4&oh=01_Q5AaIFdNmgUqP86I5VM6WLnt4i1h6wxOoPGY2kvj7wQlhE4c&oe=670EF9DE&_nc_sid=5e03e0","mediaKeyTimestamp":"1726448391","streamingSidecar":"hRM//de8KSrVng==","waveform":"AAYEAgEBAQMGFxscHBQkJBscIyMcHBUPCQQCAQEAAAEPIRwkHhgXGBQJBAIBAAAAAAAAAAAAAAAAAAAAAAAAAA==","viewOnce":true}}}}}
      case 'viewOnceMessageV2Extension': {
        // If inner content is media missing url but with caption, convert to text before unwrap
        let nextMessage: any = binMessage.message
        try {
          const inner = (binMessage as any)?.message?.message || (binMessage as any)?.message
          if (inner && typeof inner === 'object') {
            const keys = Object.keys(inner || {})
            const innerType = keys.find((k) => TYPE_MESSAGES_TO_PROCESS_FILE.includes(k))
            if (innerType) {
              const innerMsg = (inner as any)[innerType]
              if (innerMsg && !innerMsg.url && innerMsg.caption) {
                nextMessage = { conversation: innerMsg.caption }
              }
            }
          }
        } catch {}
        const changedPayload = {
          ...(payload ? (({ update: _omitUpdate3, ...r }) => r)(payload) : payload),
          message: nextMessage,
        }
        return fromBaileysMessageContent(phone, changedPayload, config)
      }

      case 'messageStubType': {
        if (isViewOnceUnavailableStub(payload)) {
          return emitViewOnceUnavailableMessage()
        }
        const isDecryptStub =
          (payload as any)?.messageStubType === 2 &&
          (payload as any)?.messageStubParameters &&
          (payload as any)?.messageStubParameters[0] &&
          MESSAGE_STUB_TYPE_ERRORS.includes(
            String((payload as any).messageStubParameters[0]).toLowerCase(),
          )
        // If decrypt failure for incoming msg: ignore stub and wait for media retry delivery
        if (isDecryptStub && !(payload as any)?.key?.fromMe) {
          logger.debug('Decrypt stub received (will wait for media retry): %s', JSON.stringify(payload?.messageStubParameters))
          return [null, senderPhone, senderId]
        }
        return [null, senderPhone, senderId]
      }

      case 'conversation':
      case 'extendedTextMessage':
        {
          // Build text body and normalize @mentions to preferred alias
          const raw = (binMessage?.text || binMessage) as string
          const ctx: any = (binMessage as any)?.contextInfo || {}
          const nameMap: Record<string, string> = ((payload as any)?.groupMetadata?.names || (payload as any)?.contactNames || {}) as any
          const participants: any[] = Array.isArray((payload as any)?.groupMetadata?.participants)
            ? ((payload as any)?.groupMetadata?.participants as any[])
            : []
          const mentioned: string[] = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : []
          const toPn = (jid: string) => {
            try {
              if (isLidUser(jid)) {
                return jidToPhoneNumber(jidNormalizedUser(jid), '').replace('+', '')
              } else {
                return jidToPhoneNumber(jid, '').replace('+', '')
              }
            } catch {
              return ''
            }
          }
          let body = `${raw || ''}`
          try {
            if (mentioned.length && body) {
              for (const mj of mentioned) {
                const lidDigits = `${mj}`.split('@')[0]
                let pnDigits = toPn(mj)
                // Fallback: derive PN from group participants when mention is a LID and mapping isn't obvious
                if ((!pnDigits || pnDigits === lidDigits) && isLidUser(mj) && participants.length) {
                  try {
                    const found = participants.find((p: any) => `${p?.lid || ''}` === `${mj}`)
                    const pnJid: string | undefined = found?.id || found?.jid
                    if (pnJid) pnDigits = jidToPhoneNumber(pnJid, '').replace('+', '')
                  } catch {}
                }
                // Prefer contactName > PN > LID digits
                let alias = pnDigits || lidDigits
                try {
                  const normalizedPnJid = (isLidUser(mj) ? jidNormalizedUser(mj) : mj) as any
                  const contactName = (
                    nameMap && (
                      nameMap[mj] ||
                      nameMap[normalizedPnJid] ||
                      // direct PN JID when known via participants
                      (participants.length ? (() => {
                        try {
                          const found = participants.find((p: any) => `${p?.lid || ''}` === `${mj}`)
                          const pnJ = found?.id || found?.jid
                          return pnJ ? (nameMap[pnJ] || undefined) : undefined
                        } catch { return undefined }
                      })() : undefined) ||
                      (pnDigits ? (nameMap[`${pnDigits}@s.whatsapp.net`] || nameMap[pnDigits]) : undefined) ||
                      (lidDigits ? nameMap[lidDigits] : undefined)
                    )
                  ) as string | undefined
                  if (contactName && contactName.trim()) alias = contactName.trim()
                } catch {}
                if (alias) {
                  const patterns = new Set<string>()
                  if (lidDigits) patterns.add(lidDigits)
                  if (pnDigits) patterns.add(pnDigits)
                  for (const d of patterns) {
                    if (!d) continue
                    // replace all occurrences of @<digits>
                    const re = new RegExp(`@${d}\b`, 'g')
                    body = body.replace(re, `@${alias}`)
                  }
                }
              }
            }
            // Fallback: se não houver mentionedJid ou houver @<digits> soltos no texto,
            // tentar substituir por alias usando o nameMap conhecido (participantes do grupo/contatos)
            try {
              if (body && typeof body === 'string' && /@\d{6,}/.test(body)) {
                // Coletar todos @<digits> e @<digits>@lid
                const seen = new Set<string>()
                const reAll = /@(\d{6,})(?:@lid)?\b/g
                let m: RegExpExecArray | null
                while ((m = reAll.exec(body)) !== null) {
                  const digits = m[1]
                  if (!digits || seen.has(digits)) continue
                  seen.add(digits)
                  // Procurar nome no nameMap via várias chaves
                  let alias: string | undefined = undefined
                  try { alias = alias || (nameMap && (nameMap[`${digits}@s.whatsapp.net`] || nameMap[digits])) } catch {}
                  try { alias = alias || (nameMap && nameMap[`${digits}@lid`]) } catch {}
                  if (alias && alias.trim()) {
                    const safe = alias.trim()
                    // Substituir todas aparições dessa menção solta
                    const re1 = new RegExp(`@${digits}\\b`, 'g')
                    const re2 = new RegExp(`@${digits}@lid\\b`, 'g')
                    body = body.replace(re1, `@${safe}`)
                    body = body.replace(re2, `@${safe}`)
                  }
                }
              }
            } catch {}
          } catch {}
          try { logger.debug('MENTION normalized: "%s" -> "%s"', raw || '', body || '') } catch {}
          message.text = { body }
        }
        message.type = 'text'
        break

      case 'reactionMessage':
        // {"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3ABBD003E80C199C7BF6"},"messageTimestamp":1676631873,"pushName":"Clairton Rodrigo Heinzen","message":{"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"31S8mj42p3wLiQ==","senderTimestamp":"1676571145","recipientKeyHash":"tz8qTGvqyPjOUw==","recipientTimestamp":"1675040504"},"deviceListMetadataVersion":2},"reactionMessage":{"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3A51A48E269AFFF123FB"},"text":"👍","senderTimestampMs":"1676631872443"}}
        const reactionId = binMessage.key.id
        if (config?.sendReactionAsReply) {
          message.text = {
            body: binMessage.text,
          }
          message.type = 'text'
          message.context = {
            message_id: reactionId,
            id: reactionId,
          }
        } else {
          message.reaction = {
            message_id: reactionId,
            emoji: binMessage.text,
          }
          message.type = 'reaction'
        }
        break

      case 'templateButtonReplyMessage':
        const replyMessageId = binMessage?.contextInfo?.stanzaId
        message.button = {
          payload: binMessage?.selectedId,
          text: binMessage?.selectedDisplayText,
        }
        message.type = 'button'
        if (replyMessageId) {
          message.context = {
            message_id: replyMessageId,
            id: replyMessageId,
          }
        }
        break

      case 'buttonsResponseMessage': {
        const replyMessageId = binMessage?.contextInfo?.stanzaId
        const payload = `${binMessage?.selectedButtonId || binMessage?.selectedDisplayText || ''}`
        const text = `${binMessage?.selectedDisplayText || binMessage?.selectedButtonId || ''}`
        message.interactive = {
          type: 'button_reply',
          button_reply: {
            id: payload,
            title: text,
          },
        }
        message.type = 'interactive'
        if (replyMessageId) {
          message.context = {
            message_id: replyMessageId,
            id: replyMessageId,
          }
        }
        break
      }

      case 'interactiveResponseMessage': {
        const replyMessageId = binMessage?.contextInfo?.stanzaId
        const parsed = parseInteractiveResponse(binMessage)
        if (parsed?.isList && parsed?.id) {
          message.interactive = {
            type: 'list_reply',
            list_reply: {
              id: `${parsed.id}`,
              title: `${parsed.title || ''}`,
              description: `${parsed.description || ''}`,
            },
          }
          message.type = 'interactive'
        } else if (parsed?.isButton && parsed?.id) {
          message.interactive = {
            type: 'button_reply',
            button_reply: {
              id: `${parsed.id}`,
              title: `${parsed.title || ''}`,
            },
          }
          message.type = 'interactive'
        } else if (parsed?.bodyText) {
          message.text = { body: `${parsed.bodyText}` }
          message.type = 'text'
        }
        if (replyMessageId) {
          message.context = {
            message_id: replyMessageId,
            id: replyMessageId,
          }
        }
        break
      }

      case 'locationMessage':
      case 'liveLocationMessage':
        const { degreesLatitude, degreesLongitude } = binMessage
        // {"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3AC859A3C2069CD40799"},"messageTimestamp":1676629467,"pushName":"Clairton Rodrigo Heinzen","message":{"locationMessage":{"degreesLatitude":-26.973182678222656,"degreesLongitude":-52.523704528808594,"jpegThumbnail":"/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAgESAAMAAAABAAEAAIdpAAQAAAABAAAAJgAAAAAAAqACAAQAAAABAAAAZKADAAQAAAABAAAAZAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAZABkAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAB//aAAwDAQACEQMRAD8A+mgQRkdDS0hwGBX7r8j69xS1k1Yo5+70qzGpJqZhMsn8CKu4mUEkMSeFC/UD16Cte1knkgU3SBJhxIoOQGHp7HqKmkTzEaPcV3DGVOCPoe1YGn/aLWVPtDJAkxwIAOSx4Jzy7MGHLHgqc8VW6EdDQrFVMo6v8q/T1o2728v8/YUnzyOWVDgcL2AH40JdQYAbRgUtIRj77hfYcmk+Tshb3c8flS5e47hvXOByfbmsu/t4XuI2uYWuPMUpHAcEbly27BIXp1z7Vr7pMYyFHoorP1GKBrR3nCkRjfukDMFx1PykHpnoaashFuM5RTLkNjlEwQPbI4qQHbzGir7nk1i6E7PZndgAtuVVi8pVVug/2j3JyeTjNbdDdtgsJmQ8lz+GBRl/77UtFTdjsf/Q+mgM5iPG7lT6NTQ478H075pf3eQfmcjn0FPMkhJIATPpyajTqMaFkIyFwPVuKzZo3iuxJaKkkl0BE7NnauwEg8c8jjGQK0SoPLZY+/NV72Bri0kgUhSwHXODgg4OOcHGD7UJoCaB5FiABQnozKOpHtk/zNcz4q1qXS7eCKKQJNdSCNZH+5GP4nIHXGa2rK0a1eVnWOPzdrCOEYRQARnoMk9zgdqw/F3h+TXrBVtiBPAxZM8Bs9Vz2zWWIc+R8m53ZYqP1mH1j4b6/p+J5rP4k1rRdWkji1AX0cbDJ6xuMZOB29ODXtdjdx39nDexDCzIHA9MjpXgtr4S1q4umtpIvJEZAkdyMLnn1549K9otLi1sLWKxtyWWFAg/AVx4L2jcuZaHvcSfU1GmqDTn1att520N2jGeOmePzqpFP5oyWVB7nJqx+7/2pP0FehynylznbCX7PevHc3UsrFyixfPIqbmO3e5GN3GBg/nXSBZDyFwPVuK5nUnSC+e4CxrMiK8RkLuXIzhI0BA4P1wTnFdKVycvkn35xVO24g+XvKPwGaPk/wCev/jtLS1N12Cx/9H6booorEoKSlooAQK7IjIMlcqe3SkIA4dwD6KMmjGUkT6MPw60DAHHSrb6iOYuC32i78pc/MvLdvlFY4tryZ/mY49BxXRJhry8X/bT/wBAFaUMUaDLYFDkwsUdOszAMt1rapFDH7ik/oP1oIx991X2HJpWY7kUsC3DJG7yIvOQjbc/Ujn8iKWPaiLEoPyjbjknj65P51JuRPnCsxHOWOP0qSR38wqrbRgEY75p20ENCynkIfxIFLsm/ufqKj2A9cn6k0bF9P1NLQep/9L6booorEoKKKKAEB2yK3vg/jSGORBtJVQOhJ7UpAIwaTYuc4yfU81SemoGHaW10t9cy3QRo5GBjMZOTgY+bIAHHoTW4pKj92qp79TTqKOYLDSC332J/l+lKAB0GKWilcBKaThEY/w5Q/0p9IC6Z2EAHnkZpp9wYgJPIVj+FL839xvyoy56u38qPn/vt+dGgH//0/puiimSSJDG0srBUQFmJ6ADkmsSh9Fec3HxE0ZrmBbSY+SHImzExdhj5Qg6YJ6nr6Ctu68Rva+JbXRnjH2e5iDeYchldyQoPoDjHrmnYDq6K5XVvEMljrmn6NbxrIblwJmOfkVshcY7nB6+laMfiDRpb3+z47pGmLFAvOCw6qGxtJ9s0AbNFYLeJ9ASUQteRhi5j5zgMDtwTjA545qW78QaNYXP2S7ukjlGMg5O3d03EAhc++KANmisi717R7G4+y3dykcmASOSFDdCxAIXPbJFa3XkUgFooooAKKKKAP/U+m6p39oL6xnsmO0TxtHn03DGauUViUfNKeDfFdtchorJy0UoCuMbcg8Hr933r1zUtGvtS1K4My7XbT4wkqj5BcpIXG36H9K7qincDzmHTdWuWstXvbcrdz6hHNMn/PKKNGRQfYdfxqitnrtz9ijuILlZIL6OSWMJGlsiiTOY9o3NxznPrmvVKKLgeTWxup9D1TSbbT5J3vLu4VJVC+XkvjLknK7O3H0qbVbHXZLfUdOMVwxeMLD9nSMRSqqAbpHI3Fsjp19K9Mt7a3tUMdtGsaszOQowCzHJP1Jqei4Hmuo2eowvM1hbXSXE0MS/IqS287KgGJVf7mOh9q9FhEghjEoAcKNwXoDjkD29KlooAKKKKQBRRRQB/9X6booorEoKKKKACiiigAooooAKKKKACiiigAooooA//9k="},"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"31S8mj42p3wLiQ==","senderTimestamp":"1676571145","recipientKeyHash":"tz8qTGvqyPjOUw==","recipientTimestamp":"1675040504"}
        message.location = {
          latitude: degreesLatitude,
          longitude: degreesLongitude,
        }
        message.type = 'location'
        break

      case 'receipt':
        const {
          receipt: { receiptTimestamp, readTimestamp },
        } = payload
        if (readTimestamp) {
          cloudApiStatus = 'read'
          messageTimestamp = readTimestamp
        } else if (receiptTimestamp) {
          cloudApiStatus = 'delivered'
          messageTimestamp = receiptTimestamp
        }
        break

      case 'messageStubType':
        MESSAGE_STUB_TYPE_ERRORS
        if (payload.messageStubType == 2 && 
            payload.messageStubParameters &&
            payload.messageStubParameters[0] &&
            MESSAGE_STUB_TYPE_ERRORS.includes(payload.messageStubParameters[0].toLowerCase())) {
          message.text = {
            body: MESSAGE_CHECK_WAAPP || t('failed_decrypt'),
          }
          message.type = 'text'
          change.value.messages.push(message)
          throw new DecryptError(data)
        } else {
          return [null, senderPhone, senderId]
        }

      case 'update':
        // Suporta formatos com payload.status OU payload.update.status
        // Evita acessar update quando inexistente
        const u: any = (payload && (payload as any).update) || {}
        if (isViewOnceUnavailableStub(payload)) {
          return emitViewOnceUnavailableMessage()
        }
        const baileysStatus = (payload as any)?.status ?? u?.status
        if (
          typeof baileysStatus === 'undefined' &&
          typeof u?.status === 'undefined' &&
          !u?.messageStubType &&
          !u?.starred
        ) {
          return [null, senderPhone, senderId]
        }
        switch (baileysStatus) {
          case 0:
          case '0':
          case 'ERROR':
            cloudApiStatus = 'failed'
            break

          case 1:
          case '1':
          case 'PENDING':
            cloudApiStatus = 'sent'
            break

          case 2:
          case '2':
          case 'SERVER_ACK':
            cloudApiStatus = 'sent'
            break

          case 3:
          case '3':
          case 'DELIVERY_ACK':
            cloudApiStatus = 'delivered'
            break

          case 4:
          case '4':
          case 'READ':
          case 5:
          case '5':
          case 'PLAYED':
            cloudApiStatus = 'read'
            break

          case 'DELETED':
            cloudApiStatus = 'deleted'
            break

          default:
            if (u && u.messageStubType && u.messageStubType == 1) {
              cloudApiStatus = 'deleted'
            } else if (u?.starred) {
              // starred in unknown, but if is starred the userd read the message
              cloudApiStatus = 'read'
            } else {
              cloudApiStatus = 'failed'
              payload = {
                update: {
                  error: 4,
                  title: `Unknown baileys status type ${baileysStatus}`,
                },
              }
            }
        }
      break
      case 'listResponseMessage':
        message.text = {
          body: payload.message.listResponseMessage.title,
        }
        message.type = 'text'
        break

      case 'listMessage': {
        const listMessage: any = binMessage || payload?.message?.listMessage || {}
        const sections = Array.isArray(listMessage.sections)
          ? listMessage.sections.map((section: any) => ({
              title: section.title || '',
              rows: (section.rows || []).map((row: any) => ({
                id: row.id || row.rowId || '',
                title: row.title || '',
                description: row.description || '',
              })),
            }))
          : []
        message.type = 'interactive'
        message.interactive = {
          type: 'list',
          header: listMessage.title ? { type: 'text', text: listMessage.title } : undefined,
          body: { text: listMessage.description || listMessage.text || '' },
          footer: listMessage.footerText ? { text: listMessage.footerText } : undefined,
          action: {
            button: listMessage.buttonText || 'Selecionar',
            sections,
          },
        }
        break
      }

      case 'buttonsMessage': {
        const buttonsMessage: any = binMessage || payload?.message?.buttonsMessage || {}
        const rawButtons = Array.isArray(buttonsMessage.buttons) ? buttonsMessage.buttons : []
        const singleSelect = parseNativeFlowSingleSelect(rawButtons)
        if (singleSelect) {
          message.type = 'interactive'
          message.interactive = {
            type: 'list',
            body: { text: buttonsMessage.contentText || buttonsMessage.text || '' },
            footer: buttonsMessage.footerText ? { text: buttonsMessage.footerText } : undefined,
            action: singleSelect,
          }
          break
        }

        const buttons = rawButtons.length
          ? rawButtons.map((button: any) => ({
              type: 'reply',
              reply: {
                id: button.buttonId || '',
                title: button.buttonText?.displayText || '',
              },
            }))
          : []
        message.type = 'interactive'
        message.interactive = {
          type: 'button',
          body: { text: buttonsMessage.contentText || buttonsMessage.text || '' },
          footer: buttonsMessage.footerText ? { text: buttonsMessage.footerText } : undefined,
          action: { buttons },
        }
        break
      }

      case 'templateMessage': {
        const templateMessage: any = binMessage || payload?.message?.templateMessage || {}
        const hydrated =
          templateMessage?.hydratedTemplate ||
          templateMessage?.fourRowTemplate ||
          templateMessage?.hydratedFourRowTemplate ||
          {}
        const hydratedButtons = Array.isArray(hydrated?.hydratedButtons) ? hydrated.hydratedButtons : []
        const buttons = hydratedButtons
          .map((button: any) => {
            if (button?.quickReplyButton) {
              return {
                type: 'reply',
                reply: {
                  id: button.quickReplyButton.id || '',
                  title: button.quickReplyButton.displayText || '',
                },
              }
            }
            if (button?.urlButton) {
              return {
                type: 'cta_url',
                url: {
                  title: button.urlButton.displayText || '',
                  link: button.urlButton.url || '',
                },
              }
            }
            if (button?.callButton) {
              return {
                type: 'cta_call',
                call: {
                  title: button.callButton.displayText || '',
                  phone_number: button.callButton.phoneNumber || '',
                },
              }
            }
            return null
          })
          .filter(Boolean)

        message.type = 'interactive'
        message.interactive = {
          type: 'button',
          header: hydrated?.hydratedTitleText
            ? { type: 'text', text: hydrated.hydratedTitleText }
            : undefined,
          body: { text: hydrated?.hydratedContentText || '' },
          footer: hydrated?.hydratedFooterText ? { text: hydrated.hydratedFooterText } : undefined,
          action: { buttons },
        }
        break
      }

      case 'interactiveMessage': {
        const interactiveMessage: any = binMessage || payload?.message?.interactiveMessage || {}
        const nfButtons = interactiveMessage?.nativeFlowMessage?.buttons || []
        for (const button of Array.isArray(nfButtons) ? nfButtons : []) {
          let params: any = {}
          try {
            params = JSON.parse(button?.buttonParamsJson || '{}')
          } catch {}
          const paymentSetting = Array.isArray(params?.payment_settings) ? params.payment_settings[0] : undefined
          if (!paymentSetting || !['pix_dynamic_code', 'pix_static_code'].includes(paymentSetting?.type)) continue
          const paymentData = paymentSetting[paymentSetting.type] || {}
          const merchantName = paymentData?.merchant_name
          const keyType = paymentData?.key_type
          const keyValue = paymentData?.key
          if (!merchantName || !keyType || !keyValue) continue
          message.type = 'text'
          message.text = {
            body: `*${merchantName}*\nChave PIX tipo *${keyType}*: ${keyValue}`,
          }
          break
        }
        if (message.type === 'text') break

        const mapButtonsFromNativeFlow = (nfButtons: any[]) =>
          Array.isArray(nfButtons)
            ? nfButtons.map((button: any) => {
                let params: any = {}
                try {
                  params = JSON.parse(button?.buttonParamsJson || '{}')
                } catch {}
                if (button?.name === 'cta_url') {
                  return {
                    type: 'cta_url',
                    url: {
                      title: params.display_text || '',
                      link: params.url || '',
                    },
                  }
                }
                if (button?.name === 'cta_call') {
                  return {
                    type: 'cta_call',
                    call: {
                      title: params.display_text || '',
                      phone_number: params.phone_number || '',
                    },
                  }
                }
                if (button?.name === 'cta_copy') {
                  return {
                    type: 'cta_copy',
                    copy_code: {
                      title: params.display_text || '',
                      code: params.copy_code || '',
                    },
                  }
                }
                return {
                  type: 'reply',
                  reply: {
                    id: params.id || '',
                    title: params.display_text || '',
                  },
                }
              })
            : []

        if (interactiveMessage?.carouselMessage?.cards?.length) {
          const cards = interactiveMessage.carouselMessage.cards.map((card: any) => {
            const header = card?.header || {}
            let headerObj: any = undefined
            if (header?.imageMessage?.url) {
              headerObj = { type: 'image', image: { link: header.imageMessage.url } }
            } else if (header?.videoMessage?.url) {
              headerObj = { type: 'video', video: { link: header.videoMessage.url } }
            } else if (header?.documentMessage?.url) {
              headerObj = { type: 'document', document: { link: header.documentMessage.url } }
            } else if (header?.title) {
              headerObj = { type: 'text', text: header.title }
            }

            return {
              header: headerObj,
              body: { text: card?.body?.text || '' },
              footer: card?.footer?.text ? { text: card.footer.text } : undefined,
              action: {
                buttons: mapButtonsFromNativeFlow(card?.nativeFlowMessage?.buttons || []),
              },
            }
          })
          message.type = 'interactive'
          message.interactive = {
            type: 'carousel',
            header: interactiveMessage?.header?.title
              ? { type: 'text', text: interactiveMessage.header.title }
              : undefined,
            body: interactiveMessage?.body?.text ? { text: interactiveMessage.body.text } : undefined,
            footer: interactiveMessage?.footer?.text ? { text: interactiveMessage.footer.text } : undefined,
            carousel: { cards },
          }
          break
        }
        const buttons = mapButtonsFromNativeFlow(nfButtons)
        message.type = 'interactive'
        message.interactive = {
          type: 'button',
          header: interactiveMessage?.header?.title
            ? { type: 'text', text: interactiveMessage.header.title }
            : undefined,
          body: { text: interactiveMessage?.body?.text || '' },
          footer: interactiveMessage?.footer?.text ? { text: interactiveMessage.footer.text } : undefined,
          action: { buttons },
        }
        break
      }

      case 'groupInviteMessage': {
        const invite: any = binMessage || payload?.message?.groupInviteMessage || {}
        const subject = invite?.groupName || invite?.groupJid || 'Grupo'
        const code = invite?.inviteCode || ''
        const inviteUrl = code ? `https://chat.whatsapp.com/${code}` : ''
        const lines = [`*Convite de grupo*: ${subject}`]
        if (inviteUrl) lines.push(inviteUrl)
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'orderMessage': {
        const order: any = binMessage || payload?.message?.orderMessage || {}
        const itemCount = Number(order?.itemCount || 0)
        const currency = `${order?.currencyCode || ''}`.trim()
        const amount1000 = Number(order?.totalAmount1000 || 0)
        const amount = Number.isFinite(amount1000) ? (amount1000 / 1000).toFixed(2) : ''
        const summary = [
          '*Pedido recebido*',
          itemCount > 0 ? `Itens: ${itemCount}` : '',
          currency && amount ? `Total: ${currency} ${amount}` : '',
        ].filter(Boolean).join('\n')
        message.type = 'text'
        message.text = { body: summary || 'Pedido recebido' }
        break
      }

      case 'pollCreationMessage':
      case 'pollCreationMessageV2':
      case 'pollCreationMessageV3':
      case 'pollCreationMessageV5': {
        const poll: any = binMessage || payload?.message?.[messageType] || {}
        const name = `${poll?.name || ''}`.trim()
        const options = Array.isArray(poll?.options) ? poll.options.map((o: any) => `${o?.optionName || ''}`.trim()).filter(Boolean) : []
        const lines = [`*Enquete*: ${name || 'sem título'}`]
        if (options.length) lines.push(`Opções: ${options.join(' | ')}`)
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'pollUpdateMessage': {
        message.type = 'text'
        message.text = { body: '*Atualização de enquete*' }
        break
      }

      case 'eventMessage':
      case 'scheduledCallCreationMessage':
      case 'scheduledCallEditMessage': {
        const eventData: any = binMessage || payload?.message?.[messageType] || {}
        const title = `${eventData?.name || eventData?.title || eventData?.description || ''}`.trim()
        const label = messageType === 'eventMessage' ? 'Evento' : 'Chamada agendada'
        const lines = [`*${label}*`]
        if (title) lines.push(title)
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'requestPhoneNumberMessage': {
        message.type = 'text'
        message.text = { body: '*Solicitação de número de telefone*' }
        break
      }

      case 'newsletterAdminInviteMessage':
      case 'newsletterFollowerInviteMessageV2': {
        const invite: any = binMessage || payload?.message?.[messageType] || {}
        const title = `${invite?.newsletterName || invite?.name || invite?.newsletterJid || ''}`.trim()
        const label = messageType === 'newsletterAdminInviteMessage'
          ? 'Convite de administrador de canal'
          : 'Convite para seguir canal'
        const lines = [`*${label}*`]
        if (title) lines.push(title)
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'questionMessage':
      case 'questionReplyMessage': {
        const fp: any = binMessage || payload?.message?.[messageType] || {}
        const inner: any = fp?.message || {}
        const text =
          `${inner?.conversation || inner?.extendedTextMessage?.text || inner?.questionResponseMessage?.text || ''}`.trim()
        const label = messageType === 'questionMessage' ? 'Pergunta' : 'Resposta de pergunta'
        message.type = 'text'
        message.text = { body: text ? `*${label}*\n${text}` : `*${label}*` }
        break
      }

      case 'questionResponseMessage': {
        const questionResponse: any = binMessage || payload?.message?.questionResponseMessage || {}
        const text = `${questionResponse?.text || ''}`.trim()
        message.type = 'text'
        message.text = { body: text ? `*Resposta de pergunta*\n${text}` : '*Resposta de pergunta*' }
        break
      }

      case 'statusQuestionAnswerMessage': {
        const statusAnswer: any = binMessage || payload?.message?.statusQuestionAnswerMessage || {}
        const text = `${statusAnswer?.text || ''}`.trim()
        message.type = 'text'
        message.text = { body: text ? `*Resposta de pergunta de status*\n${text}` : '*Resposta de pergunta de status*' }
        break
      }

      case 'callLogMesssage': {
        const callLog: any = binMessage || payload?.message?.callLogMesssage || {}
        const duration = Number(callLog?.durationSecs || 0)
        const mode = callLog?.isVideo ? 'vídeo' : 'voz'
        const outcome = `${callLog?.callOutcome || 'UNKNOWN'}`.trim()
        const lines = [
          '*Registro de chamada*',
          `Tipo: ${mode}`,
          `Resultado: ${outcome}`,
          duration > 0 ? `Duração: ${duration}s` : '',
        ].filter(Boolean)
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'pollResultSnapshotMessage':
      case 'pollResultSnapshotMessageV3': {
        const pollSnapshot: any = binMessage || payload?.message?.[messageType] || {}
        const pollName = `${pollSnapshot?.name || ''}`.trim()
        const votes = Array.isArray(pollSnapshot?.pollVotes)
          ? pollSnapshot.pollVotes
              .map((vote: any) => {
                const name = `${vote?.optionName || ''}`.trim()
                const count = Number(vote?.optionVoteCount || 0)
                return name ? `${name}: ${count}` : ''
              })
              .filter(Boolean)
          : []
        const lines = [`*Resultado de enquete*${pollName ? `: ${pollName}` : ''}`]
        if (votes.length) lines.push(votes.join(' | '))
        message.type = 'text'
        message.text = { body: lines.join('\n') }
        break
      }

      case 'statusQuotedMessage': {
        const statusQuoted: any = binMessage || payload?.message?.statusQuotedMessage || {}
        const text = `${statusQuoted?.text || ''}`.trim()
        message.type = 'text'
        message.text = { body: text ? `*Status citado*\n${text}` : '*Status citado*' }
        break
      }

      case 'statusAddYours': {
        const fp: any = binMessage || payload?.message?.statusAddYours || {}
        const inner: any = fp?.message || {}
        const text = `${inner?.conversation || inner?.extendedTextMessage?.text || ''}`.trim()
        message.type = 'text'
        message.text = { body: text ? `*Status Add Yours*\n${text}` : '*Status Add Yours*' }
        break
      }

      case 'statusMentionMessage':
        break

      case 'messageContextInfo':
      case 'senderKeyDistributionMessage':
      case 'albumMessage':
      case 'keepInChatMessage':
        logger.debug(`Ignore message type ${messageType}`)
        return [null, senderPhone, senderId]

      default:
        cloudApiStatus = 'failed'
        payload = {
          update: {
            error: 4,
            title: `Unknown baileys message type ${messageType}`,
          },
        }
    }
    // const repository = await getRepository(this.phone, this.config)
    if (cloudApiStatus) {
      const messageId = cloudApiStatusMessageId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let recipientPn = (
        // 1) outro lado (preferência absoluta)
        ensurePn(senderPhone) ||
        // 2) alternativas explícitas
        ensurePn((payload as any)?.key?.participantPn) ||
        ensurePn((payload as any)?.participantPn) ||
        ensurePn((payload as any)?.key?.senderPn) ||
        // 3) fallbacks a partir de JIDs brutos
        ensurePn(senderId) ||
        ensurePn((payload as any)?.key?.remoteJid) ||
        ensurePn((payload as any)?.key?.remoteJidAlt) ||
        ensurePn((payload as any)?.key?.participantAlt) ||
        ensurePn((payload as any)?.participantAlt) ||
        ''
      )
      let conversationId = chatJid
      try {
        const normalizedConversationId = normalizeUserOrGroupIdForWebhook(chatJid)
        if (normalizedConversationId) conversationId = normalizedConversationId
      } catch {}
      if (!conversationId || `${conversationId}` === `${phone}`.replace('+', '')) {
        if (recipientPn) conversationId = recipientPn
      }
      const state: any = {
        conversation: {
          id: conversationId,
          // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
        },
        id: messageId,
        recipient_id: recipientPn || senderId,
        status: cloudApiStatus,
      }
      if (groupMetadata.group_id) {
        state.recipient_id = normalizeGroupId(groupMetadata.group_id)
        state.recipient_type = 'group'
      }
      // Defensivo: se recipient_id ficou vazio ou igual ao número do próprio canal,
      // force usar o PN do outro lado (senderPhone derivado do remoteJid)
      try {
        const channelPn = `${phone}`.replace('+', '')
        const otherSide = ensurePn(senderPhone)
        if (!state.recipient_id || `${state.recipient_id}` === channelPn) {
          if (otherSide) state.recipient_id = otherSide
        }
      } catch {}
      // Preencher timestamp do status (Cloud API espera esse campo). Usar em ordem:
      // 1) messageTimestamp calculado a partir de receipt/read
      // 2) payload.messageTimestamp, se existir
      try {
        if (messageTimestamp) {
          state['timestamp'] = `${messageTimestamp}`
        } else if (payload.messageTimestamp) {
          state['timestamp'] = payload.messageTimestamp.toString()
        }
      } catch {}
      if (cloudApiStatus == 'failed') {
        const error = extractFailedStatusError(payload)
        state.errors = [error]
        try {
          logger.warn(
            'STATUS failed detail: id=%s recipient_id=%s code=%s title=%s error_data=%s',
            messageId || '<none>',
            state.recipient_id || '<none>',
            `${error?.code || '<none>'}`,
            error?.title || '<none>',
            error?.error_data ? JSON.stringify(error.error_data) : '<none>'
          )
        } catch {}
      }
      change.value.statuses.push(state)
      // Normalize webhook IDs to preferred scheme (PN with BR 9th digit) when configured
      try { if (WEBHOOK_PREFER_PN_OVER_LID) normalizeWebhookValueIds(change.value) } catch {}
      try {
        logger.info('STATUS map: id=%s to recipient_id=%s status=%s', messageId || '<none>', state.recipient_id || '<none>', cloudApiStatus || '<none>')
      } catch {}
    } else {
      // {"key":{"remoteJid":"554988290955@s.whatsapp.net","fromMe":false,"id":"3A4F0B7A946F046A1AD0"},"messageTimestamp":1676632069,"pushName":"Clairton Rodrigo Heinzen","message":{"extendedTextMessage":{"text":"Isso","contextInfo":{"stanzaId":"BAE50C61B223F799","participant":"554998360838@s.whatsapp.net","quotedMessage":{"conversation":"*Odonto Excellence*: teste"}}},"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"31S8mj42p3wLiQ==","senderTimestamp":"1676571145","recipientKeyHash":"tz8qTGvqyPjOUw==","recipientTimestamp":"1675040504"},"deviceListMetadataVersion":2}}}
      const stanzaId = binMessage?.contextInfo?.stanzaId
      if (stanzaId) {
        message.context = {
          message_id: stanzaId,
          id: stanzaId,
        }
      }

      // {"key":{"remoteJid":"554936213177@s.whatsapp.net","fromMe":false,"id":"1EBD1D8356472403AFE7102D05D6B21B"},"messageTimestamp":1698057926,"pushName":"Odonto Excellence","broadcast":false,"message":{"extendedTextMessage":{"text":"https://fb.me/4QHYHT0Fv","matchedText":"https://fb.me/4QHYHT0Fv","previewType":"NONE","contextInfo":{"forwardingScore":1,"isForwarded":true,"externalAdReply":{"title":"Converse conosco!","body":"🤩 PRÓTESE FLEXÍVEL: VOCÊ JÁ CONHECE? 🤩\\n\\n✅ Maior Conforto\\n✅ Mais Natural\\n✅ Mais Bonita\\n✅ Sem Grampos Aparentes\\n\\nEstes são os benefícios que a PRÓTESE FLEXÍVEL pode te proporcionar. Tenha a sua LIBERDADE de volta, e volte a sorrir e a comer com tranquilidade!!! 🍎🌽🥩🍗\\n\\n⭐ ESSA É SUA CHANCE, NÃO DEIXE PASSAR!\\n\\n📲 Garanta sua avaliação e vamos falar a respeito dessa possibilidade de TRANSFORMAÇÃO!! 💖","mediaType":"VIDEO","thumbnailUrl":"https://scontent.xx.fbcdn.net/v/t15.5256-10/341500845_517424053756219_5530967817243282036_n.jpg?stp=dst-jpg_s851x315&_nc_cat=105&ccb=1-7&_nc_sid=0808e3&_nc_ohc=K-u3hFrS1xcAX-NaRwd&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&oh=00_AfDNIQXVcym0OF49i-UJSEX0rri9IlrwXPQkcXOpTfH-xQ&oe=653A3E2F","mediaUrl":"https://www.facebook.com/OdontoExcellenceSaoMiguel/videos/179630185187923/","thumbnail":"/9j/4AAQSkZJRgABAQAAAQABAAD/7QCEUGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAGgcAigAYkZCTUQwYTAwMGE2YzAxMDAwMGQ5MDEwMDAwNzMwMjAwMDBiZDAyMDAwMGZkMDIwMDAwODMwMzAwMDAxZDA0MDAwMDU0MDQwMDAwOTYwNDAwMDBkYTA0MDAwMGQyMDUwMDAwAP/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/CABEIADIAMgMBIgACEQEDEQH/xAAaAAADAQEBAQAAAAAAAAAAAAAABAUGAwEC/8QAFwEBAQEBAAAAAAAAAAAAAAAAAQIDBP/aAAwDAQACEAMQAAAB7LotYdhMZYrOdwuhecNATMOzmNYureQ4GdHHXONXmxwSJaaQdvKOdak0MuMJQExenyFK1ADneUCsEgM+v//EACAQAAICAgICAwAAAAAAAAAAAAECAAMEERMhBRIUIjH/2gAIAQEAAQUC3031hfqx9ytG4iZuLb3vrgdyfGXNER6i+IjThSFwRh07WnWlEyKxbXe5xLPnLFb2lFjTfEj5Lqfn9M9OSp8RVvFx/vlXqinyF5OJkKQ11Ix7by7aee6CWqjwr6u4BRVIHIQeZo37L+pV+CZQHpP/xAAgEQACAQMEAwAAAAAAAAAAAAAAAgEDEjEQERMhMkFR/9oACAEDAQE/AWSGOOFzJUT3BaIkxgslsCq6FwsRBU2iOhdvp1pXwU/LT//EAB0RAAICAQUAAAAAAAAAAAAAAAABEBEhAgMSMUH/2gAIAQIBAT8BTGxZUbjvoWkqizj6VkRcuP/EACQQAAEDAwQCAwEAAAAAAAAAAAEAAhEDECESMUFRImEEIDKB/9oACAEBAAY/Ar+1J3F828RKa4aRHBUVGwpavysoPdJnhYs5pxPK01P4e1vZjGtwhjJUNXk2UW1WYPaxUcpcITG03eY64TdWw6CfU+Q4NKjVJ9IFohb24atMyjnKww/UQhaYzb//xAAfEAEAAwEAAgMBAQAAAAAAAAABABEhMWFxQVGRoRD/2gAIAQEAAT8hqsZpCOo1gfCKSW36f7RQYbuVXsGLPSbTxVksdfnjOxb/ACFWm/UxiC46BchpDwjVaM43GfSWyx9cNsBitlCoVAsKMtA9Uv1UEYf4ngAkKSM+DJsWuAza92sGRD8NFxGszcyE+XkXYp8sUbp+T25b0eScE8oBYH1OPB8jMi309ngYoOzZ4fE3d9TmUFGu1Byf/9oADAMBAAIAAwAAABCpUH4aO33xxv8AdjiD/8QAGhEBAQEBAQEBAAAAAAAAAAAAAQARMSEQcf/aAAgBAwEBPxATSPdACcX511eQmAIml+bAHhLEM2x9NWQ5crh8/8QAGhEBAQEAAwEAAAAAAAAAAAAAAQARECExQf/aAAgBAgEBPxBTpgSHlZMcjZCWlidvac6tHvEvt44//8QAIhABAAICAwEAAQUAAAAAAAAAAQARITFBUXFhkaGxwdHh/9oACAEBAAE/ELgC6IhR1ESCHFWGi8xRFxrP+D+8pJeObUEMSiHbfsaiXJlL/JU8W88CEAakQX4OmXygd1e0CCqM/UPBXx8gSHoA49g3iVFEDuzfdRK6UiCvhPGBDJqBi+feyWmG+okWXwHcu5BhA0ZqIF5VuouFW0XqUB/Vg/2Ic4Sw7B4bMj9Imnqgujq3c1ClB+sMFSoUAVS6v5Cs1Vazt3fkU1aHEUweytNAnJsrfVzTNey/SIkytuMRZpdEXSy4G4qghkGk4hVrKwtXryAQAbSymCI0jhCj+CI5KzdABLFtwWEULXJYQxAjl0wYr/MSmXU//9k=","sourceType":"ad","sourceId":"120200422938230365","sourceUrl":"https://fb.me/4QHYHT0Fv","containsAutoReply":false,"renderLargerThumbnail":true,"showAdAttribution":true,"ctwaClid":"ARA5EWTktP0VPr7ZyKkYKKQN_HfFye5re1giQ6os1ZjiFa0Pdftvs-ESdUtWgOjkEoBsJ_mCh86z8dBguiatoESpGwM"}},"inviteLinkGroupTypeV2":"DEFAULT"},"messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"BmI9Pyppe2nL+A==","senderTimestamp":"1696945176","recipientKeyHash":"ltZ5vMXiILth5A==","recipientTimestamp":"1697942459"},"deviceListMetadataVersion":2}},"verifiedBizName":"Odonto Excellence"}
      const editInfo = extractMessageEditInfo(payload)
      if (editInfo?.originalMessageId) {
        message.message_type = 'message_edit'
        message.context = {
          message_id: editInfo.originalMessageId,
          id: editInfo.originalMessageId,
        }
        if (editInfo.timestampMs) message.edit_timestamp = editInfo.timestampMs
      }

      const externalAdReply = binMessage?.contextInfo?.externalAdReply
      if (externalAdReply) {
        message.referral = {
          source_url: externalAdReply.sourceUrl,
          source_id: externalAdReply.sourceId,
          source_type: externalAdReply.sourceType,
          headline: externalAdReply.title,
          body: externalAdReply.body,
          media_type: externalAdReply.mediaType,
          image_url: externalAdReply.thumbnail,
          video_url: externalAdReply.mediaUrl,
          thumbnail_url: externalAdReply.thumbnailUrl,
          ctwa_clid: externalAdReply.ctwaClid,
        }

        if (message.type == 'text') {
          message.text.body = `${message.text.body}
            ${externalAdReply.title}

            ${externalAdReply.body}
          
            ${externalAdReply.mediaUrl || externalAdReply.thumbnailUrl}
          `
        }
      }
      change.value.messages.push(message)
      // Normalize webhook IDs (contacts/messages/statuses) if preference is set
      try { if (WEBHOOK_PREFER_PN_OVER_LID) normalizeWebhookValueIds(change.value) } catch {}
    }
    // Log resumido de identificação (evita serializar WAProto inteiro)
    try {
      const contactWa = (data as any)?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id
      const msgFrom = (data as any)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const k: any = (payload as any)?.key || {}
      const logRemote = k?.remoteJid || (payload as any)?.remoteJid
      const logSenderPn = k?.senderPn || (payload as any)?.senderPn
      const logParticipantPn = k?.participantPn || (payload as any)?.participantPn
      logger.info('WEBHOOK ids: wa_id=%s from=%s remoteJid=%s senderPn=%s participantPn=%s', contactWa || '<none>', msgFrom || '<none>', logRemote || '<none>', logSenderPn || '<none>', logParticipantPn || '<none>')
    } catch {}
    logger.debug('fromBaileysMessageContent %s => %s', phone, JSON.stringify(data))
    return [data, senderPhone, senderId]
  } catch (e) {
    logger.error(e, 'Error on convert baileys to cloud-api')
    throw e
  }
}

export const toBuffer = (arrayBuffer) => {
  const buffer = Buffer.alloc(arrayBuffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}
