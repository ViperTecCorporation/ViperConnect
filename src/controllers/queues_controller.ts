import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { getAuthHeaderToken } from '../services/security'
import { managerAdmin } from '../services/manager_access'
import { RabbitManagement, RabbitManagementError } from '../services/rabbitmq_management'

type QueueManager = Pick<RabbitManagement, 'listQueues' | 'previewMessages' | 'removeMessages' | 'purgeQueue'>

export class QueuesController {
  constructor(
    private readonly manager: QueueManager = new RabbitManagement(),
    private readonly adminToken = UNOAPI_AUTH_TOKEN,
  ) {}

  private isAdmin(req: Request): boolean {
    return managerAdmin(req) || (!!this.adminToken && getAuthHeaderToken(req).trim() === this.adminToken)
  }

  private sendError(res: Response, error: unknown) {
    const status = error instanceof RabbitManagementError ? error.status : 500
    const message = error instanceof Error ? error.message : 'rabbit_management_error'
    return res.status(status).json({ error: message })
  }

  async list(req: Request, res: Response) {
    if (!this.isAdmin(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      return res.status(200).json({ queues: await this.manager.listQueues() })
    } catch (error) {
      return this.sendError(res, error)
    }
  }

  async preview(req: Request, res: Response) {
    if (!this.isAdmin(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      const count = Math.min(200, Math.max(1, Number(req.query.limit) || 20))
      return res.status(200).json({
        queue: req.params.queue,
        messages: await this.manager.previewMessages(req.params.queue, count, `${req.query.session || ''}`),
      })
    } catch (error) {
      return this.sendError(res, error)
    }
  }

  async purge(req: Request, res: Response) {
    if (!this.isAdmin(req)) return res.status(403).json({ error: 'admin_token_required' })
    if (`${req.body?.confirm || ''}` !== req.params.queue) {
      return res.status(400).json({ error: 'queue_confirmation_mismatch' })
    }
    try {
      if (req.body?.count === 'all') {
        await this.manager.purgeQueue(req.params.queue)
        return res.status(200).json({ queue: req.params.queue, purged: true, removed: 'all' })
      }
      const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1))
      const removed = await this.manager.removeMessages(req.params.queue, count)
      return res.status(200).json({ queue: req.params.queue, purged: true, removed })
    } catch (error) {
      return this.sendError(res, error)
    }
  }
}
