import OpenAI, { toFile } from 'openai'
import { getConfig, Webhook } from '../services/config'
import logger from '../services/logger'
import { Outgoing } from '../services/outgoing'
import { BASE_URL } from '../defaults'
import mediaToBuffer from '../utils/media_to_buffer'
import { extractDestinyPhone, jidToPhoneNumber } from '../services/transformer'
import { jidNormalizedUser, isPnUser } from '@whiskeysockets/baileys'
import { v1 as uuid } from 'uuid'
import Audio2TextJS from 'audio2textjs'
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'fs'
import { SESSION_DIR } from '../services/session_store_file'
import mime from 'mime'

const firstNonEmptyString = (...values: unknown[]) => {
  for (const value of values) {
    const text = `${value || ''}`.trim()
    if (text) return text
  }
  return ''
}

export const extractTranscriptionDestiny = (payload: any, audioMessage: any) => {
  const value = payload?.entry?.[0]?.changes?.[0]?.value
  const contact = value?.contacts?.[0]
  const destinyPhone = extractDestinyPhone(payload, false)
  return firstNonEmptyString(
    destinyPhone,
    audioMessage?.group_id,
    audioMessage?.from,
    audioMessage?.from_user_id,
    contact?.group_id,
    contact?.wa_id,
    contact?.user_id,
    value?.metadata?.phone_number_id,
  )
}

export class TranscriberJob {
  private service: Outgoing
  private getConfig: getConfig

  constructor(service: Outgoing, getConfig: getConfig) {
    this.service = service
    this.getConfig = getConfig
  }

  async consume(phone: string, data: object) {
    try {
      const { payload, webhooks }: { payload: any; webhooks: Webhook[] } = data as any
      const payloadEntry = payload?.entry && payload.entry[0]
      const payloadValue = payloadEntry &&
        payload.entry[0].changes &&
        payload.entry[0].changes[0] &&
        payload.entry[0].changes[0].value
      const audioMessage = payloadValue &&
        payload.entry[0].changes[0].value.messages &&
        payload.entry[0].changes[0].value.messages[0]
      const destinyPhone = extractTranscriptionDestiny(payload, audioMessage)

      const config = await this.getConfig(phone)
      const mediaKey = audioMessage.audio.id
      let token = config.authToken
      let mediaUrl = `${BASE_URL}/v13.0/${mediaKey}`
      if (config.connectionType == 'forward') {
        mediaUrl = `${config.webhookForward.url}/${config.webhookForward.version}/${mediaKey}`
        token = config.webhookForward.token
      }
      const { buffer, link, mimeType } = await mediaToBuffer(
        mediaUrl,
        token!,
        webhooks[0].timeoutMs || 0,
      )
      const extension = config.connectionType == 'forward' ? `.${mime.extension(mimeType)}` : ''
      let transcriptionText = ''
      if (config.groqApiKey) {
        try {
          logger.debug('Transcriber audio with Groq for session %s to %s', phone, destinyPhone)
          const splitedLink = link.split('/')
          const originalName = `${splitedLink[splitedLink.length - 1]}${extension}`
          const allowed = new Set(['flac','mp3','mp4','mpeg','mpga','m4a','ogg','opus','wav','webm'])
          const nameParts = originalName.split('.')
          const rawExt = (nameParts.length > 1 ? nameParts[nameParts.length - 1] : '').toLowerCase()
          let normExt = rawExt
          if (normExt === 'oga') {
            normExt = 'ogg'
          }
          if (!allowed.has(normExt) || !normExt) {
            normExt = 'ogg'
          }
          const baseName = nameParts.length > 1 ? nameParts.slice(0, -1).join('.') : (originalName || 'audio')
          const uploadName = `${baseName}.${normExt}`
          const file = await toFile(buffer, uploadName)
          const form = new FormData()
          form.append('file', file as unknown as Blob)
          form.append('model', config.groqApiTranscribeModel || 'whisper-large-v3')
          const baseUrl = (config.groqApiBaseUrl || 'https://api.groq.com/openai/v1').replace(/\/$/, '')
          // Timeout e retry leves para melhorar robustez de rede
          const abortMs = (() => { try { return (webhooks?.[0]?.timeoutMs as number) || 60000 } catch { return 60000 } })()
          const fetchWithRetry = async (input: string, init: any, attempts = 2): Promise<Response> => {
            let lastErr: any
            for (let i = 0; i < attempts; i++) {
              try {
                const controller = AbortSignal.timeout(abortMs)
                const merged = { ...(init || {}), signal: controller }
                // @ts-ignore
                return await fetch(input, merged)
              } catch (e: any) {
                lastErr = e
                const name = (e?.name || '').toString()
                const code = (e?.cause?.code || e?.code || '').toString()
                const transient = name === 'AbortError' || ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND'].includes(code)
                if (i + 1 < attempts && transient) {
                  await new Promise((r) => setTimeout(r, 800))
                  continue
                }
                break
              }
            }
            throw lastErr
          }
          const res = await fetchWithRetry(`${baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.groqApiKey}`,
            },
            body: form as unknown as BodyInit,
          })
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            throw new Error(`Groq transcription failed: ${res.status} ${res.statusText} ${errText}`)
          }
          const json = await res.json() as { text?: string }
          transcriptionText = json.text || ''
        } catch (ge) {
          logger.warn(ge as any, 'Groq transcription failed; trying fallback')
          if (config.openaiApiKey) {
            // fallback para OpenAI
            const openai = new OpenAI({ apiKey: config.openaiApiKey })
            const splitedLink = link.split('/')
            const fileName = `${splitedLink[splitedLink.length - 1]}${extension}`
            const transcription = await openai.audio.transcriptions.create({
              file: await toFile(buffer, fileName),
              model: config.openaiApiTranscribeModel || 'gpt-4o-mini-transcribe',
            })
            transcriptionText = transcription.text
          } else {
            // fallback local
            const converter = new Audio2TextJS({
              threads: 4,
              processors: 1,
              outputJson: true,
            })
            if (!existsSync(SESSION_DIR)) {
              mkdirSync(SESSION_DIR)
            }
            if (!existsSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)) {
              mkdirSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)
            }
            const tempFile = `${SESSION_DIR}/${mediaKey}`
            writeFileSync(tempFile, buffer)
            const result = await converter.runWhisper(tempFile, 'tiny', 'auto')
            transcriptionText = result.output
            rmSync(tempFile)
          }
        }
      } else if (config.openaiApiKey) {
        logger.debug('Transcriber audio with OpenAI for session %s to %s', phone, destinyPhone)
        const openai = new OpenAI({ apiKey: config.openaiApiKey })
        const splitedLink = link.split('/')
        const fileName = `${splitedLink[splitedLink.length - 1]}${extension}`
        try {
          const transcription = await openai.audio.transcriptions.create({
            file: await toFile(buffer, fileName),
            model: config.openaiApiTranscribeModel || 'gpt-4o-mini-transcribe',
          })
          transcriptionText = transcription.text
        } catch (oe) {
          logger.warn(oe as any, 'OpenAI transcription failed; trying local fallback')
          const converter = new Audio2TextJS({
            threads: 4,
            processors: 1,
            outputJson: true,
          })
          if (!existsSync(SESSION_DIR)) {
            mkdirSync(SESSION_DIR)
          }
          if (!existsSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)) {
            mkdirSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)
          }
          const tempFile = `${SESSION_DIR}/${mediaKey}`
          writeFileSync(tempFile, buffer)
          const result = await converter.runWhisper(tempFile, 'tiny', 'auto')
          transcriptionText = result.output
          rmSync(tempFile)
        }
      } else {
        logger.debug('Transcriber audio with Audio2TextJS for session %s to %s', phone, destinyPhone)
        const converter = new Audio2TextJS({
            threads: 4,
            processors: 1,
            outputJson: true,
        })
        if (!existsSync(SESSION_DIR)) {
          mkdirSync(SESSION_DIR)
        }
        if (!existsSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)) {
          mkdirSync(`${SESSION_DIR}/${mediaKey.split('/')[0]}`)
        }
        const tempFile = `${SESSION_DIR}/${mediaKey}`
        writeFileSync(tempFile, buffer)
        const result = await converter.runWhisper(tempFile, 'tiny', 'auto')
        transcriptionText = result.output
        rmSync(tempFile)
      }
      logger.debug('Transcriber audio content for session %s and to %s is %s', phone, destinyPhone, transcriptionText)
      const output = { ...payload }
      const transcriptionFrom = firstNonEmptyString(
        audioMessage.from,
        audioMessage.from_user_id,
        payloadValue?.contacts?.[0]?.wa_id,
        payloadValue?.contacts?.[0]?.user_id,
      )
      output.entry[0].changes[0].value.messages = [{
        context: {
          message_id: audioMessage.id,
          id: audioMessage.id,
        },
        from: transcriptionFrom,
        ...(audioMessage.from_user_id && audioMessage.from_user_id !== transcriptionFrom ? { from_user_id: audioMessage.from_user_id } : {}),
        ...(audioMessage.group_id ? { group_id: audioMessage.group_id } : {}),
        id: uuid(),
        text: { body: transcriptionText },
        type: 'text',
        timestamp: `${parseInt(audioMessage.timestamp) + 1}`,
      }]
      // Preferir PN sobre LID no payload do webhook (mesma regra do OutgoingCloudApi)
      try {
        const store = await config.getStore(phone, config)
        const ds: any = store?.dataStore
        const v: any = output?.entry?.[0]?.changes?.[0]?.value || {}
        const toPnIfMapped = async (x?: string): Promise<string> => {
          let val = `${x || ''}`
          if (!val) return val
          if (val.includes('@g.us')) return val
          // 1) JID LID explícito -> tentar PN via cache/normalização
          if (val.includes('@lid')) {
            try {
              const mapped = await ds?.getPnForLid?.(phone, val)
              if (mapped) return jidToPhoneNumber(mapped, '')
            } catch {}
            try {
              const normalized = jidNormalizedUser(val)
              if (normalized && isPnUser(normalized as any)) {
                try { await ds?.setJidMapping?.(phone, normalized as any, val) } catch {}
                return jidToPhoneNumber(normalized, '')
              }
            } catch {}
          }
          // 2) Digitos puros podem ser LID-nu (sem sufixo). Tentar tratar como LID.
          try {
            if (/^\d+$/.test(val)) {
              const lidJid = `${val}@lid`
              try {
                const mapped2 = await ds?.getPnForLid?.(phone, lidJid)
                if (mapped2) return jidToPhoneNumber(mapped2, '')
              } catch {}
              try {
                const normalized2 = jidNormalizedUser(lidJid)
                if (normalized2 && isPnUser(normalized2 as any)) return jidToPhoneNumber(normalized2, '')
              } catch {}
            }
          } catch {}
          try {
            if (val.includes('@s.whatsapp.net')) return jidToPhoneNumber(val, '')
          } catch {}
          return val
        }
        if (Array.isArray(v.contacts)) {
          for (const c of v.contacts) {
            if (c && typeof c.wa_id === 'string') c.wa_id = await toPnIfMapped(c.wa_id)
          }
        }
        if (Array.isArray(v.messages)) {
          for (const m of v.messages) {
            if (m && typeof m.from === 'string') m.from = await toPnIfMapped(m.from)
          }
        }
      } catch {}
      await Promise.all(
        webhooks.map(async (w) => {
          logger.debug('Transcriber phone %s to %s sending webhook %s', phone, destinyPhone, w.id)
          return this.service.sendHttp(phone, w, output, {})
        }),
      )
    } catch (error) {
      logger.error(error)
    }
  }
}
