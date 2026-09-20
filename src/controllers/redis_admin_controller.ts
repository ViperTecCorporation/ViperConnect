import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { RedisAdmin, RedisAdminError, RedisKeyType } from '../services/redis_admin'
import { getAuthHeaderToken } from '../services/security'
import { managerAdmin } from '../services/manager_access'

type RedisManager = Pick<RedisAdmin, 'listKeys' | 'listTree' | 'getKey' | 'saveKey' | 'deleteKey' | 'deletePrefix' | 'query'>

export class RedisAdminController {
  constructor(
    private readonly manager: RedisManager = new RedisAdmin(),
    private readonly adminToken = UNOAPI_AUTH_TOKEN,
  ) {}

  private authorized(req: Request): boolean {
    return managerAdmin(req) || (!!this.adminToken && getAuthHeaderToken(req).trim() === this.adminToken)
  }

  private error(res: Response, value: unknown) {
    const status = value instanceof RedisAdminError ? value.status : 500
    return res.status(status).json({ error: value instanceof Error ? value.message : 'redis_admin_error' })
  }

  async list(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      return res.status(200).json({
        keys: await this.manager.listKeys(`${req.query.search || ''}`, Number(req.query.limit) || 200),
      })
    } catch (error) {
      return this.error(res, error)
    }
  }

  async tree(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      const prefix = `${req.query.prefix || ''}`
      return res.status(200).json({
        prefix,
        nodes: await this.manager.listTree(prefix, Number(req.query.limit) || 100),
      })
    } catch (error) {
      return this.error(res, error)
    }
  }

  async removeTree(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    const prefix = `${req.query.prefix || ''}`
    if (`${req.body?.confirm || ''}` !== prefix) {
      return res.status(400).json({ error: 'redis_prefix_confirmation_mismatch' })
    }
    try {
      return res.status(200).json({
        prefix,
        removed: await this.manager.deletePrefix(prefix),
      })
    } catch (error) {
      return this.error(res, error)
    }
  }

  async get(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      return res.status(200).json(await this.manager.getKey(req.params.key))
    } catch (error) {
      return this.error(res, error)
    }
  }

  async save(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    if (`${req.body?.confirm || ''}` !== req.params.key) return res.status(400).json({ error: 'redis_key_confirmation_mismatch' })
    try {
      await this.manager.saveKey(
        req.params.key,
        `${req.body?.type || 'string'}` as RedisKeyType,
        req.body?.value,
        Number(req.body?.ttlSeconds ?? -1),
      )
      return res.status(200).json({ key: req.params.key, saved: true })
    } catch (error) {
      return this.error(res, error)
    }
  }

  async remove(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    if (`${req.body?.confirm || ''}` !== req.params.key) return res.status(400).json({ error: 'redis_key_confirmation_mismatch' })
    try {
      return res.status(200).json({ key: req.params.key, removed: await this.manager.deleteKey(req.params.key) })
    } catch (error) {
      return this.error(res, error)
    }
  }

  async query(req: Request, res: Response) {
    if (!this.authorized(req)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      const args = Array.isArray(req.body?.args) ? req.body.args.map((item: unknown) => `${item}`) : []
      return res.status(200).json({ result: await this.manager.query(`${req.body?.command || ''}`, args) })
    } catch (error) {
      return this.error(res, error)
    }
  }
}
