import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { getAuthHeaderToken } from '../services/security'
import { webhookHistory, WebhookHistory, WebhookHistoryError, publicWebhookHistory } from '../services/webhook_history'

export class WebhookHistoryController {
  constructor(private readonly history: WebhookHistory = webhookHistory, private readonly token = UNOAPI_AUTH_TOKEN) {}
  async handle(req: Request, res: Response) {
    if (!this.token || getAuthHeaderToken(req).trim() !== this.token) return res.status(403).json({ error: 'admin_token_required' })
    const phone = req.params.phone
    if (!/^\d{5,20}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' })
    try {
      if (req.method === 'GET') return res.json({ snapshots: (await this.history.entries(phone)).map(publicWebhookHistory) })
      const body = req.body
      if (!body || typeof body.snapshot_id !== 'string' || !Array.isArray(body.webhook_ids)
        || !body.webhook_ids.length || body.webhook_ids.length > 100
        || body.webhook_ids.some((id: unknown) => typeof id !== 'string' || !id || id.length > 200)
        || new Set(body.webhook_ids).size !== body.webhook_ids.length
        || (body.replace_existing !== undefined && typeof body.replace_existing !== 'boolean')) {
        return res.status(400).json({ error: 'invalid_restore_request' })
      }
      await this.history.restore(phone, body.snapshot_id, body.webhook_ids, body.replace_existing === true)
      return res.json({ restored: body.webhook_ids, enabled: false })
    } catch (error) {
      return res.status(error instanceof WebhookHistoryError ? error.status : 503)
        .json({ error: error instanceof WebhookHistoryError ? error.message : 'webhook_history_unavailable' })
    }
  }
}
