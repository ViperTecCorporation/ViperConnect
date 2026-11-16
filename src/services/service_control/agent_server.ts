import express from 'express'
import type { ServiceControlAgent } from './agent'
import { controlAuthorized } from './http'
import { componentId, operationId, ServiceControlError } from './types'
import { ServiceLogService } from './log_service'
import { logOptions } from './log_types'

export function serviceControlServer(agent: ServiceControlAgent, token: string, logs?: ServiceLogService) {
  if (token.length < 32) throw new Error('control_token_too_short')
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!controlAuthorized(req.headers.authorization, token)) return void res.status(403).json({ error: 'control_forbidden' })
    next()
  })
  app.use(express.json({ limit: '8kb', strict: true }))
  app.use(async (req, res) => {
    try {
      if (req.method === 'GET' && req.path === '/v1/targets') return void res.json(await agent.overview())
      const log = req.path.match(/^\/v1\/targets\/([^/]+)\/logs$/)
      if (req.method === 'GET' && log && componentId(log[1])) {
        const options = logOptions(req.query)
        if (!logs) throw new ServiceControlError(503, 'logs_not_configured')
        return await logs.stream(log[1], options, res)
      }
      const operation = req.path.match(/^\/v1\/operations\/([^/]+)$/)
      if (req.method === 'GET' && operation && operationId(operation[1])) return void res.json(agent.operation(operation[1]))
      const restart = req.path.match(/^\/v1\/targets\/([^/]+)\/restart$/)
      if (req.method === 'POST' && restart && componentId(restart[1])) {
        const actor = typeof req.body?.actor === 'string' ? req.body.actor : 'admin'
        return void res.status(202).json(await agent.submit(restart[1], req.body, actor))
      }
      res.status(404).json({ error: 'control_not_found' })
    } catch (error) { res.status(error instanceof ServiceControlError ? error.status : 503).json({ error: error instanceof ServiceControlError ? error.code : 'control_unavailable' }) }
  })
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: 'control_request_invalid' }) })
  return app
}
