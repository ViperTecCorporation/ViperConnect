import type { Request, Response } from 'express'
import type { getConfig } from '../services/config'
import { managerPrincipal, managerToken } from '../services/manager_access'
import { resolveSessionPhoneByMetaId } from '../services/meta_alias'
import { authorizedSessionMessages, SessionMessages } from '../services/messages/session_messages'
import { SessionMessageMedia } from '../services/messages/session_message_media'
import { SendError } from '../services/send_error'

export class SessionMessagesController {
  private readonly media: SessionMessageMedia
  constructor(private readonly service: SessionMessages, private readonly load: getConfig) { this.media = new SessionMessageMedia(service) }
  async handle(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const phone = await resolveSessionPhoneByMetaId(req.params.phone)
      const principal = managerPrincipal(req)
      const allowed = principal ? principal.role === 'admin' || principal.phones.includes(phone) : await authorizedSessionMessages(managerToken(req), phone, this.load)
      if (!allowed) return void res.status(403).json({ error: 'session_messages_forbidden' })
      if (req.params.messageId) {
        const result = await this.media.load(phone, req.params.messageId)
        const config = await this.load(phone)
        const { mediaStore } = await config.getStore(phone, config)
        res.setHeader('X-Content-Type-Options', 'nosniff')
        // Documents/HTML must not execute in the panel's authenticated origin.
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename || 'media')}"`)
        res.contentType(result.mime_type || 'application/octet-stream')
        const stream = await mediaStore.downloadMediaStream(result.file)
        if (!stream) throw new SendError(404, 'message_media_not_found')
        res.on('close', () => stream.destroy())
        stream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy() })
        stream.pipe(res)
        return
      }
      const query = { cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        ids: typeof req.query.ids === 'string' ? req.query.ids.split(',') : undefined,
        around: typeof req.query.around === 'string' ? req.query.around : undefined,
        statusIds: typeof req.query.status_ids === 'string' ? req.query.status_ids.split(',') : undefined,
        conversationIds: typeof req.query.conversation_ids === 'string' ? req.query.conversation_ids.split(',') : undefined }
      const page = req.params.conversationId ? await this.service.messages(phone, req.params.conversationId, query) : await this.service.conversations(phone, query)
      res.json(page)
    } catch (error) {
      const code = error instanceof SendError ? error.code : 503
      if (!res.headersSent) res.status(code).json({ error: error instanceof SendError ? error.title : 'session_messages_unavailable' })
    }
  }
}
