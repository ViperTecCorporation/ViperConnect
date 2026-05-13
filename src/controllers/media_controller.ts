import { NextFunction, Request, Response } from 'express'
import { getConfig } from '../services/config'
import logger from '../services/logger'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'
import { SessionStore } from '../services/session_store'
import { sendGraphError } from '../services/graph_error'

export class MediaController {
  private baseUrl: string
  private getConfig: getConfig
  private sessionStore: SessionStore

  constructor(baseUrl: string, getConfig: getConfig, sessionStore: SessionStore) {
    this.baseUrl = baseUrl
    this.getConfig = getConfig
    this.sessionStore = sessionStore
  }

  public async indexNoPhone(req: Request, res: Response, next: NextFunction) {
    logger.debug('media index (no phone) method %s', req.method)
    logger.debug('media index (no phone) params %s', JSON.stringify(req.params))
    const mediaId = `${req.params.media_id || ''}`.trim()
    if (!mediaId) return next()
    try {
      const phones = await this.sessionStore.getPhones()
      for (const phone of phones) {
        try {
          const config = await this.getConfig(phone)
          const store = await config.getStore(phone, config)
          const { mediaStore } = store
          const mediaResult = await mediaStore.getMedia(this.baseUrl, mediaId)
          if (mediaResult) return res.status(200).json(mediaResult)
        } catch {}
      }
      return next()
    } catch {
      return next()
    }
  }

  public async index(req: Request, res: Response) {
    logger.debug('media index method %s', req.method)
    logger.debug('media index headers %s', JSON.stringify(req.headers))
    logger.debug('media index params %s', JSON.stringify(req.params))
    logger.debug('media index body %s', JSON.stringify(req.body))
    const { phone, media_id: mediaId } = req.params
    const sessionPhone = await resolveSessionPhoneByMetaId(phone)
    const config = await this.getConfig(sessionPhone)
    const store = await config.getStore(sessionPhone, config)
    const { mediaStore } = store
    const mediaResult = await mediaStore.getMedia(this.baseUrl, mediaId)
    if (mediaResult) {
      logger.debug('media index response %s', JSON.stringify(mediaResult))
      return res.status(200).json(mediaResult)
    } else {
      logger.debug('media index response 404')
      return sendGraphError(res, 404, '(#100) Unsupported get request. Object with ID does not exist', { code: 100, type: 'GraphMethodException' })
    }
  }

  public async typebot(req: Request, res: Response) {
    logger.debug('media typebot method %s', req.method)
    logger.debug('media typebot headers %s', JSON.stringify(req.headers))
    logger.debug('media typebot params %s', JSON.stringify(req.params))
    logger.debug('media typebot body %s', JSON.stringify(req.body))
    const raw = `${req.params.media_id || ''}`
    const match = raw.match(/^(\d+)-(.+)$/)
    if (!match) {
      logger.debug('media typebot invalid id %s', raw)
      return res.sendStatus(404)
    }
    const [, phone, mediaId] = match
    try {
      const config = await this.getConfig(phone)
      const store = await config.getStore(phone, config)
      const { mediaStore, dataStore } = store
      const mediaPayload: any = await dataStore.loadMediaPayload(mediaId)
      if (!mediaPayload) {
        logger.debug('media typebot not found %s', mediaId)
        return res.sendStatus(404)
      }
      let mediaResult: any
      try {
        mediaResult = await mediaStore.getMedia(this.baseUrl, mediaId)
      } catch (e) {
        logger.warn(e as any, 'media typebot failed to compute download url %s', mediaId)
      }
      const mimeType = mediaResult?.mime_type || mediaPayload?.mime_type || mediaPayload?.content_type
      const url: string | undefined = mediaResult?.url || mediaPayload?.url
      if (!url) {
        logger.debug('media typebot missing url %s', mediaId)
        return res.sendStatus(404)
      }
      const sha256 = mediaPayload?.sha256
      const response: any = {
        url,
        mime_type: mimeType,
        id: raw,
        messaging_product: 'whatsapp',
      }
      if (sha256) response.sha256 = sha256
      if (mediaPayload?.file_size) response.file_size = mediaPayload.file_size
      return res.status(200).json(response)
    } catch (e) {
      logger.warn(e as any, 'media typebot error %s', raw)
      return sendGraphError(res, 500, 'internal_error', { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async download(req: Request, res: Response) {
    logger.debug('media download method %s', req.method)
    logger.debug('media download headers %s', JSON.stringify(req.headers))
    logger.debug('media download params %s', JSON.stringify(req.params))
    logger.debug('media download body %s', JSON.stringify(req.body))
    const { phone, file } = req.params
    const sessionPhone = await resolveSessionPhoneByMetaId(phone)
    const config = await this.getConfig(sessionPhone)
    const store = await config.getStore(sessionPhone, config)
    const { mediaStore } = store
    return mediaStore.downloadMedia(res, `${sessionPhone}/${file}`)
  }
}
