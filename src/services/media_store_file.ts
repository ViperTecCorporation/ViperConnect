import { proto, WAMessage, downloadMediaMessage, downloadContentFromMessage, Contact } from '@whiskeysockets/baileys'
import { getBinMessage, jidToPhoneNumberIfUser, toBuffer, ensurePn, phoneNumberToJid } from './transformer'
import { writeFile } from 'fs/promises'
import { existsSync, mkdirSync, rmSync, createReadStream, statSync } from 'fs'
import { MediaStore, getMediaStore, mediaStores } from './media_store'
import mime from 'mime-types'
import { Response } from 'express'
import { getDataStore } from './data_store'
import { Config } from './config'
import logger from './logger'
import { DATA_URL_TTL, FETCH_TIMEOUT_MS, DOWNLOAD_AUDIO_CONVERT_TO_MP3 } from '../defaults'
import { convertBufferToMp3 } from '../utils/audio_convert_mp3'
import fetch, { Response as FetchResponse } from 'node-fetch'
import mediaToBuffer from '../utils/media_to_buffer'

export const MEDIA_DIR = '/medias'

export const getMediaStoreFile: getMediaStore = (phone: string, config: Config, getDataStore: getDataStore): MediaStore => {
  if (!mediaStores.has(phone)) {
    logger.debug('Creating media store file %s', phone)
    const store = mediaStoreFile(phone, config, getDataStore)
    mediaStores.set(phone, store)
  } else {
    logger.debug('Retrieving media store file %s', phone)
  }
  return mediaStores.get(phone) as MediaStore
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mediaStoreFile = (phone: string, config: Config, getDataStore: getDataStore): MediaStore => {
  const PROFILE_PICTURE_FOLDER = 'profile-pictures'
  const profilePictureFileName = (phone) => `${phone}.jpg`
  const sanitizeProfileId = (input?: string): string => {
    try {
      let s = `${input || ''}`.trim()
      if (!s) return ''
      if (s.includes('@lid@s.whatsapp.net')) s = s.replace('@lid@s.whatsapp.net', '@lid')
      const pn = ensurePn(s)
      if (pn) return pn
      if (s.includes('@lid')) return `${s.split('@')[0].split(':')[0]}@lid`
      return s
    } catch {
      return `${input || ''}`
    }
  }

  const mediaStore: MediaStore = {} as MediaStore
  mediaStore.type = 'file'

  mediaStore.getFilePath = (phone: string, mediaId: string, mimeType: string, fileName?: string) => {
    let extension = mime.extension(mimeType) as string | false
    if (!extension && fileName) {
      const baseName = `${fileName}`.split(/[\\/]/).pop() || ''
      const dot = baseName.lastIndexOf('.')
      if (dot > 0 && dot < baseName.length - 1) {
        const ext = baseName.slice(dot + 1).toLowerCase()
        if (/^[a-z0-9]{1,10}$/.test(ext)) extension = ext
      }
    }
    if (!extension) extension = 'bin'
    return `${phone}/${mediaId}.${extension}`
  }

  mediaStore.saveMediaForwarder = async (message: any) => {
    let inMime = message[message.type].mime_type as string
    let convertToMp3 = false
    if (DOWNLOAD_AUDIO_CONVERT_TO_MP3 && message.type === 'audio') {
      const low = (inMime || '').toLowerCase()
      if (low.includes('ogg') || low.includes('opus') || low.includes('oga')) {
        convertToMp3 = true
      }
    }
    const filePath = mediaStore.getFilePath(
      phone,
      message.id,
      convertToMp3 ? 'audio/mpeg' : inMime,
      message[message.type].filename,
    )
    const url = `${config.webhookForward.url}/${config.webhookForward.version}/${message[message.type].id}`
    const { buffer } = await mediaToBuffer(url, config.webhookForward.token!, config.webhookForward?.timeoutMs || 0)
    const outBuffer = convertToMp3 ? await convertBufferToMp3(buffer) : buffer
    logger.debug('Saving buffer %s...', filePath)
    await mediaStore.saveMediaBuffer(filePath, outBuffer)
    logger.debug('Saved buffer %s!', filePath)
    const mediaId = `${phone}/${message.id}`
    // "type"=>"audio", "audio"=>{"mime_type"=>"audio/ogg; codecs=opus", "sha256"=>"HgQo1XoLPSCGlIQYu7eukl4ty1yIu2kAWvoKgqLCnu4=", "id"=>"642476532090165", "voice"=>true}}]
    const payload = {
      messaging_product: 'whatsapp',
      mime_type: convertToMp3 ? 'audio/mpeg' : message[message.type].mime_type,
      sha256: message[message.type].sha256,
      // file_size: binMessage?.message?.fileLength,
      id: mediaId,
      filename: (convertToMp3 ? filePath : (message[message.type].filename || filePath)),
    }
    const dataStore = await getDataStore(phone, config)
    await dataStore.setMediaPayload(message.id, payload)
    message[message.type].id = mediaId
    return message
  }

  mediaStore.getFileUrl = async (fileName: string, _expiresIn = DATA_URL_TTL) => {
    return `${config.baseStore}${MEDIA_DIR}/${fileName}`
  }

  mediaStore.getDownloadUrl = async (baseUrl: string, filePath: string) => {
    return `${baseUrl}/v15.0/download/${filePath}`
  }

  const mapMediaType = {
    imageMessage: 'image',
    videoMessage: 'video',
    documentMessage: 'document',
    stickerMessage: 'sticker',
    audioMessage: 'audio',
    ptvMessage: 'video',
  }

  mediaStore.saveMedia = async (waMessage: WAMessage) => {
    let buffer
    const initial = getBinMessage(waMessage)
    const candidates: any[] = []
    const normalizeMk = (m: any) => {
      try {
        const mk = (m as any)?.message?.mediaKey
        if (mk && !(mk instanceof Uint8Array)) {
          if (typeof mk === 'string') {
            ;(m as any).message.mediaKey = Uint8Array.from(Buffer.from(mk, 'base64'))
          } else if (typeof mk === 'object') {
            // handle Node Buffer JSON ({ type: 'Buffer', data: number[] })
            if ((mk as any)?.type === 'Buffer' && Array.isArray((mk as any)?.data)) {
              ;(m as any).message.mediaKey = Uint8Array.from(((mk as any).data as number[]))
            } else {
              // handles {0:..,1:..} and other array-like shapes
              const vals = Object.values(mk as any).filter((x) => typeof x === 'number') as number[]
              if (vals.length) {
                ;(m as any).message.mediaKey = Uint8Array.from(vals)
              }
            }
          }
        }
      } catch {}
    }
    let binMessage = initial
    normalizeMk(binMessage)
    const ensureBestFromPersisted = async () => {
      try {
        const ds = await getDataStore(phone, config)
        const persistedM = await ds.loadMessage(waMessage.key.remoteJid!, waMessage.key.id!)
        if (persistedM) {
          const persistedBin = getBinMessage(persistedM)
          normalizeMk(persistedBin)
          const persistedMk: any = persistedBin?.message?.mediaKey
          const currentMk: any = binMessage?.message?.mediaKey
          const len = (v: any) => (v instanceof Uint8Array ? v.length : ((v?.type === 'Buffer' && Array.isArray(v?.data)) ? v.data.length : (v && Object.keys(v).length) || 0))
          if (len(persistedMk) > len(currentMk)) {
            binMessage = persistedBin
          } else if (persistedMk && currentMk) {
            try {
              const a = persistedMk instanceof Uint8Array ? persistedMk : Uint8Array.from((persistedMk?.data || Object.values(persistedMk || {})) as number[])
              const b = currentMk instanceof Uint8Array ? currentMk : Uint8Array.from((currentMk?.data || Object.values(currentMk || {})) as number[])
              if (a && b && Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
                candidates.push(persistedBin)
              }
            } catch {}
          }
          if (binMessage?.message && persistedBin?.message) {
            binMessage.message.fileEncSha256 = binMessage.message.fileEncSha256 || persistedBin.message.fileEncSha256
            binMessage.message.fileSha256 = binMessage.message.fileSha256 || persistedBin.message.fileSha256
            binMessage.message.mediaKeyTimestamp = binMessage.message.mediaKeyTimestamp || persistedBin.message.mediaKeyTimestamp
            binMessage.message.streamingSidecar = binMessage.message.streamingSidecar || persistedBin.message.streamingSidecar
          }
        }
      } catch {}
    }
    await ensureBestFromPersisted()

    // If mediaKey is missing/too short, wait briefly for media-retry to update store
    const keyLen = (mk: any) => (mk instanceof Uint8Array ? mk.length : ((mk?.type === 'Buffer' && Array.isArray(mk?.data)) ? mk.data.length : (mk && Object.keys(mk).length) || 0))
    let attempts = 0
    while ((keyLen(binMessage?.message?.mediaKey) < 32) && attempts < 6) {
      await new Promise((r) => setTimeout(r, 1000))
      await ensureBestFromPersisted()
      attempts++
    }
    const tryDownload = async (ctx: any) => {
      const mediaUrl = ctx?.message?.url || initial?.message?.url
      const directPath = ctx?.message?.directPath || initial?.message?.directPath
      if (!ctx || !ctx.message || (!mediaUrl && !directPath)) {
        throw new Error('Missing media context to download media')
      }
      if (mediaUrl && mediaUrl.indexOf('base64') >= 0) {
        const base64 = mediaUrl.split(',')[1]
        return Buffer.from(base64, 'base64')
      }
      const content: any = {
        mediaKey: ctx?.message?.mediaKey,
        directPath,
        url: directPath ? `https://mmg.whatsapp.net${directPath}` : mediaUrl,
        fileEncSha256: ctx?.message?.fileEncSha256,
        fileSha256: ctx?.message?.fileSha256,
        mediaKeyTimestamp: ctx?.message?.mediaKeyTimestamp,
        mimetype: ctx?.message?.mimetype,
        streamingSidecar: ctx?.message?.streamingSidecar,
      }
      // primary: use directPath decrypt stream
      const downloadViaContent = async (firstBlockIsIV = false) => {
        const media = await (downloadContentFromMessage as any)(
          content,
          mapMediaType[ctx?.messageType],
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          firstBlockIsIV
        )
        const chunks: any[] = []
        for await (const chunk of media) {
          chunks.push(chunk)
        }
        return Buffer.concat(chunks)
      }
      try {
        return await downloadViaContent(false)
      } catch (err1: any) {
        const msg1 = `${err1?.message || err1}`.toLowerCase()
        if (msg1.includes('bad decrypt')) {
          try {
            logger.warn('Retry download media toggling firstBlockIsIV = true')
            return await downloadViaContent(true)
          } catch (err2: any) {
            // final fallback: use downloadMediaMessage helper
            const toDownloadMessage = { key: waMessage.key, message: { [ctx?.messageType!]: ctx?.message }} as WAMessage
            return await downloadMediaMessage(toDownloadMessage, 'buffer', {})
          }
        }
        // non-decrypt errors: fallback to Baileys helper
        const toDownloadMessage = { key: waMessage.key, message: { [ctx?.messageType!]: ctx?.message }} as WAMessage
        return await downloadMediaMessage(toDownloadMessage, 'buffer', {})
      }
    }
    try {
      buffer = await tryDownload(binMessage)
    } catch (e: any) {
      const msg = `${e?.message || e}`.toLowerCase()
      const ossl = `${e?.code || ''}`.toLowerCase()
      const isBadDecrypt = msg.includes('bad decrypt') || ossl.includes('ossl')
      if (isBadDecrypt && candidates.length) {
        try {
          buffer = await tryDownload(candidates[0])
        } catch (e2) {
          throw e2
        }
      } else {
        throw e
      }
    }
    return mediaStore.saveDownloadedMedia!(waMessage, buffer)
  }

  mediaStore.saveDownloadedMedia = async (waMessage: WAMessage, buffer: Buffer) => {
    const initial = getBinMessage(waMessage)
    const binMessage = initial
    let chosenMime: string = binMessage?.message?.mimetype
    let outBuffer: Buffer = buffer
    try {
      if (DOWNLOAD_AUDIO_CONVERT_TO_MP3 && initial?.messageType && (mapMediaType[initial.messageType] === 'audio')) {
        const low = (chosenMime || '').toLowerCase()
        const looksOgg = low.includes('ogg') || low.includes('opus') || low.includes('oga')
        if (looksOgg) {
          logger.debug('Converting downloaded audio to MP3 for %s', waMessage.key.id)
          outBuffer = await convertBufferToMp3(buffer)
          chosenMime = 'audio/mpeg'
        }
      }
    } catch (e) {
      logger.warn(e as any, 'Failed to convert audio to MP3; storing original')
      outBuffer = buffer
    }
    const filePath = mediaStore.getFilePath(
      phone,
      waMessage.key.id!,
      chosenMime,
      (binMessage as any)?.message?.fileName,
    )
    logger.debug('Saving buffer %s...', filePath)
    await mediaStore.saveMediaBuffer(filePath, outBuffer)
    logger.debug('Saved buffer %s!', filePath)
    const mediaId = waMessage.key.id
    const mimeType = mime.lookup(filePath)
    // Gerar link direto (7 dias) usando o backend de storage (S3 gera presigned)
    const downloadUrl = await mediaStore.getFileUrl(filePath, 60 * 60 * 24 * 7)
    const payload = {
      messaging_product: 'whatsapp',
      mime_type: mimeType,
      sha256: binMessage?.message?.fileSha256,
      file_size: binMessage?.message?.fileLength,
      id: `${phone}/${mediaId}`,
      filename: (chosenMime === 'audio/mpeg' ? filePath : (binMessage?.message?.fileName || filePath)),
      url: downloadUrl,
    }
    const dataStore = await getDataStore(phone, config)
    await dataStore.setMediaPayload(mediaId!, payload)
    // Propagar a URL para o payload da mensagem (webhook)
    try {
      const type = initial?.messageType && mapMediaType[initial.messageType]
      if (type && (waMessage as any)?.message?.[initial.messageType]) {
        ;(waMessage as any).message[initial.messageType].url = downloadUrl
      }
    } catch {}
    return waMessage
  }

  mediaStore.saveMediaBuffer = async (fileName: string, content: Buffer) => {
    const filePath = await mediaStore.getFileUrl(fileName, DATA_URL_TTL)
    const parts = filePath.split('/')
    const dir: string = parts.splice(0, parts.length - 1).join('/')
    if (!existsSync(dir)) {
      mkdirSync(dir)
    }
    await writeFile(filePath, content)
    return true
  }

  mediaStore.removeMedia = async (fileName: string) => {
    const filePath = await mediaStore.getFileUrl(fileName, DATA_URL_TTL)
    return rmSync(filePath)
  }

  mediaStore.downloadMedia = async (res: Response, file: string) => {
    const stream = await mediaStore.downloadMediaStream(file)
    if (!stream) {
      logger.error('Not retrieve the media: %', file)
      res.sendStatus(404)
      return
    }
    const withoutExtension = file.replace(/\.[^/.]+$/, '')
    const mediaId = withoutExtension.split('/')[1]
    if (mediaId) {
      const dataStore = await getDataStore(phone, config)
      const mediaPayload = await dataStore.loadMediaPayload(mediaId!)
      if (mediaPayload?.filename) {
        res.setHeader('Content-disposition', `attachment; filename="${encodeURIComponent(mediaPayload.filename)}"`)
      }
      if (mediaPayload?.content_type) {
        res.contentType(mediaPayload.content_type)
      }
    }
    stream.pipe(res)
  }

  mediaStore.downloadMediaStream = async (file: string) => {
    const filePath = await mediaStore.getFileUrl(file, DATA_URL_TTL)
    return createReadStream(filePath)
  }

  mediaStore.getMedia = async (baseUrl: string, mediaId: string) => {
    const dataStore = await getDataStore(phone, config)
    const mediaPayload = await dataStore.loadMediaPayload(mediaId!)
    if (!mediaPayload) {
      logger.debug('media getMedia not found: %s', mediaId)
      return undefined
    }
    const mimeType = mediaPayload?.mime_type || mediaPayload?.content_type
    if (!mimeType) {
      logger.debug('media getMedia missing mime_type: %s', mediaId)
      return undefined
    }
    const filePath = mediaStore.getFilePath(phone, mediaId!, mimeType, mediaPayload?.filename)
    const url = await mediaStore.getDownloadUrl(baseUrl, filePath)
    const payload = {
      ...mediaPayload,
      url,
    }
    return payload
  }

  const profilePictureIdsFor = async (jid?: string, contact?: Partial<Contact>): Promise<string[]> => {
    const ids = new Set<string>()
    const add = (value?: string) => {
      const id = sanitizeProfileId(value)
      if (id) ids.add(id)
    }
    const original = `${jid || contact?.id || ''}`.trim()
    add(original)
    add((contact as any)?.lid)
    try {
      const ds = await getDataStore(phone, config)
      const pn = ensurePn(original)
      const lid = original.includes('@lid') ? sanitizeProfileId(original) : ''
      if (pn) {
        const pnJid = phoneNumberToJid(pn)
        add(pnJid)
        add(await (ds as any).getLidForPn?.(phone, pnJid))
      }
      if (lid) {
        const pnJid = await (ds as any).getPnForLid?.(phone, lid)
        add(pnJid)
        const pnDigits = ensurePn(pnJid)
        if (pnDigits) add(await (ds as any).getLidForPn?.(phone, phoneNumberToJid(pnDigits)))
      }
    } catch {}
    return Array.from(ids)
  }

  mediaStore.getProfilePictureInfo = async (baseUrl: string, jid: string) => {
    const ids = await profilePictureIdsFor(jid)
    logger.debug('Profile picture path candidate ids: %s (from %s)', ids.join(','), jid)
    const base = await mediaStore.getFileUrl(PROFILE_PICTURE_FOLDER, DATA_URL_TTL)
    for (const id of ids) {
      const fName = profilePictureFileName(id)
      const complete = `${base}/${fName}`
      if (existsSync(complete)) {
        const stat = statSync(complete)
        return {
          url: `${baseUrl}/v15.0/download/${phone}/${PROFILE_PICTURE_FOLDER}/${fName}`,
          metadata: {
            content_length: `${stat.size}`,
            last_modified: stat.mtime.toISOString(),
            content_type: 'image/jpeg',
          },
        }
      }
    }
    return undefined
  }

  mediaStore.getProfilePictureUrl = async (baseUrl: string, jid: string) => {
    return (await mediaStore.getProfilePictureInfo?.(baseUrl, jid))?.url
  }

  mediaStore.saveProfilePicture = async (contact: Contact) => {
    const originalId = contact.id as string
    const targetIds = await profilePictureIdsFor(originalId, contact)

    if (['changed', 'removed'].includes(contact.imgUrl || '')) {
      for (const targetId of targetIds) {
        const fName = profilePictureFileName(targetId)
        try { await mediaStore.removeMedia(`${PROFILE_PICTURE_FOLDER}/${fName}`) } catch {}
      }
      return
    }
    if (contact.imgUrl) {
      const base = await mediaStore.getFileUrl(PROFILE_PICTURE_FOLDER, DATA_URL_TTL)
      if (!existsSync(base)) {
        mkdirSync(base, { recursive: true })
      }
      logger.info('PROFILE_PICTURE saving (FS) targets: %s (from %s)', targetIds.join(','), originalId)
      const response: FetchResponse = await fetch(contact.imgUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method: 'GET'})
      const buffer = toBuffer(await response.arrayBuffer())
      for (const targetId of targetIds) {
        const fName = profilePictureFileName(targetId)
        const complete = `${base}/${fName}`
        try {
          await writeFile(complete, buffer)
          logger.info('PROFILE_PICTURE saved (FS): %s', jidToPhoneNumberIfUser(targetId))
        } catch (e) {
          logger.warn(e as any, 'Ignore error saving profile picture %s', targetId)
        }
      }
    }
  }

  return mediaStore
}
