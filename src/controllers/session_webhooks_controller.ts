import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { getAuthHeaderToken } from '../services/security'
import { getConfig } from '../services/redis'
import { sessionWebhookStore, SessionWebhookStore } from '../services/session_webhook_store'
import { publicSessionDestination, SessionWebhookValidationError, validateSessionDestination } from '../services/session_webhook_contract'

export class SessionWebhooksController {
  constructor(
    private readonly store: SessionWebhookStore = sessionWebhookStore,
    private readonly config = getConfig,
    private readonly adminToken = UNOAPI_AUTH_TOKEN,
  ) {}

  async handle(req: Request, res: Response) {
    // Do not pass these routes through session-token authentication/logging.
    if (!this.adminToken || getAuthHeaderToken(req).trim() !== this.adminToken) return res.status(403).json({ error: 'admin_token_required' })
    try {
      if (req.path.endsWith('/states') && req.method === 'GET') {
        const destination = req.query.destination_id
        const destinations = await this.store.destinations()
        const selected = destination ? destinations.find(d => d.id === destination) : undefined
        if (destination && !selected) return res.status(404).json({ error: 'destination_not_found' })
        const states = (await this.store.states()).filter(state => !selected || selected.session_ids.includes(state.session.id))
        return res.json({ states })
      }
      const destinations = await this.store.destinations()
      const previous = req.params.id ? destinations.find(d => d.id === req.params.id) : undefined
      if (req.params.id && !previous) return res.status(404).json({ error: 'destination_not_found' })
      if (req.method === 'GET') return res.json({ destinations: destinations.map(publicSessionDestination) })
      if (req.method === 'DELETE') {
        await this.store.removeDestination(req.params.id)
        return res.status(204).end()
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new SessionWebhookValidationError('invalid_body')
      const value = validateSessionDestination(req.body, previous)
      if (!previous && destinations.length >= 100) throw new SessionWebhookValidationError('destination_limit_reached')
      for (const phone of value.session_ids) {
        const config = await this.config(phone)
        if (!config || (config.server || 'server_1') !== value.server) throw new SessionWebhookValidationError('session_server_mismatch')
        if (config.provider !== 'zapo') throw new SessionWebhookValidationError('session_provider_not_supported')
      }
      await this.store.save(value)
      return res.status(previous ? 200 : 201).json(publicSessionDestination(value))
    } catch (error) {
      if (error instanceof SessionWebhookValidationError) return res.status(400).json({ error: error.message })
      return res.status(503).json({ error: 'session_webhooks_unavailable' })
    }
  }
}
