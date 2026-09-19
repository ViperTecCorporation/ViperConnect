import { Request, Response } from 'express'
import logger from '../services/logger'
import { addToBlacklist } from '../services/blacklist'

export class BlacklistController {
  private addToBlacklist: addToBlacklist

  constructor(addToBlacklist: addToBlacklist) {
    this.addToBlacklist = addToBlacklist
  }

  async update(req: Request, res: Response) {
    logger.debug('blacklist method %s', req.method)
    logger.debug('blacklist headers %s', JSON.stringify(req.headers))
    logger.debug('blacklist params %s', JSON.stringify(req.params))
    logger.debug('blacklist body %s', JSON.stringify(req.body))
    const to = req.body.to || req.query.to
    const ttl = Number(req.body.ttl ?? req.query.ttl ?? 0)
    if (typeof to !== 'string' || !to.trim()) {
      logger.info('blacklist error: to param is required')
      return res.status(400).send(`{"error": "to param is required"}`)
    }
    if (!Number.isSafeInteger(ttl)) return res.status(400).json({ error: 'ttl must be an integer in seconds' })
    const { webhook_id, phone } = req.params
    await this.addToBlacklist(phone, webhook_id, to, ttl)
    res.status(200).send(`{"success": true}`)
  }
}
