import type { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { managerAdmin } from '../services/manager_access'
import { getAuthHeaderToken } from '../services/security'
import { resourceMetricsQuery } from '../services/resource_metrics/runtime'
import { METRIC_RANGES, MetricRange, validId } from '../services/resource_metrics/types'

export class ResourceMetricsController {
  constructor(private readonly service = resourceMetricsQuery, private readonly token = UNOAPI_AUTH_TOKEN) {}
  async handle(req: Request, res: Response) {
    if (!managerAdmin(req) && !(this.token && getAuthHeaderToken(req).trim() === this.token)) return res.status(403).json({ error: 'admin_token_required' })
    res.setHeader('Cache-Control', 'no-store')
    const id = req.params.component, range = `${req.query.range || '1d'}` as MetricRange
    if (id && (!validId(id) || !METRIC_RANGES.includes(range))) return res.status(400).json({ error: 'resource_metrics_query_invalid' })
    try {
      const service = await this.service()
      return res.json(id ? await service.history(id, range) : await service.current())
    } catch { return res.status(503).json({ error: 'resource_metrics_unavailable' }) }
  }
}
