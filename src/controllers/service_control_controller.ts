import type { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { managerAdmin, managerPrincipal } from '../services/manager_access'
import { getAuthHeaderToken } from '../services/security'
import { ServiceControlClient } from '../services/service_control/client'
import { controlAuthorized } from '../services/service_control/http'
import { restartSafety } from '../services/service_control/safety'
import { componentId, operationId, ServiceControlError } from '../services/service_control/types'

export class ServiceControlController {
  constructor(private readonly client = new ServiceControlClient(), private readonly adminToken = UNOAPI_AUTH_TOKEN,
    private readonly safety = restartSafety, private readonly guardToken = process.env.SERVICE_CONTROL_GUARD_TOKEN || '') {}
  async guard(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    if (!controlAuthorized(req.headers.authorization, this.guardToken)) return res.status(403).json({ error: 'control_forbidden' })
    try { return res.json(await this.safety()) } catch (error) { return this.error(res, error) }
  }
  async handle(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    if (!managerAdmin(req) && !(this.adminToken && getAuthHeaderToken(req).trim() === this.adminToken)) return res.status(403).json({ error: 'control_admin_required' })
    try {
      if (req.method === 'GET' && !req.params.component && !req.params.operation) return res.json(await this.client.overview())
      if (req.method === 'GET' && operationId(req.params.operation)) return res.json(await this.client.operation(req.params.operation))
      if (req.method !== 'POST' || !componentId(req.params.component) || !operationId(req.body?.operationId)
        || req.body.confirm !== req.params.component || typeof req.body.confirmation !== 'string' || req.body.confirmation.length > 1024) return res.status(400).json({ error: 'control_request_invalid' })
      return res.status(202).json(await this.client.restart(req.params.component,
        { operationId: req.body.operationId, confirm: req.body.confirm, confirmation: req.body.confirmation }, managerPrincipal(req)?.id || 'global-admin'))
    } catch (error) { return this.error(res, error) }
  }
  private error(res: Response, error: unknown) { return res.status(error instanceof ServiceControlError ? error.status : 503).json({ error: error instanceof ServiceControlError ? error.code : 'control_unavailable' }) }
}
