import type { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { managerAdmin } from '../services/manager_access'
import { getAuthHeaderToken } from '../services/security'
import { ServiceLogProxy } from '../services/service_control/log_proxy'
import { logOptions } from '../services/service_control/log_types'
import { componentId, ServiceControlError } from '../services/service_control/types'

export class ServiceLogsController {
  constructor(private readonly proxy = new ServiceLogProxy(), private readonly token = UNOAPI_AUTH_TOKEN) {}
  async handle(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    if (!managerAdmin(req) && !(this.token && getAuthHeaderToken(req).trim() === this.token)) return res.status(403).json({ error: 'logs_admin_required' })
    try {
      if (!componentId(req.params.component)) throw new ServiceControlError(400, 'logs_query_invalid')
      return await this.proxy.stream(req.params.component, logOptions(req.query), res)
    } catch (error) { return res.status(error instanceof ServiceControlError ? error.status : 503).json({ error: error instanceof ServiceControlError ? error.code : 'logs_source_unavailable' }) }
  }
}
