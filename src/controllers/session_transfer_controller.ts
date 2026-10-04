import { Router, json } from 'express'
import { managerIdentity, ManagerError } from '../services/manager_identity'
import { MobileDeviceError } from '../services/mobile_device_service'
import { createSessionTransfer } from '../services/session_transfer/runtime'

export function sessionTransferRouter(identity = managerIdentity, runtime = createSessionTransfer) {
  const router = Router()
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const header = req.headers.authorization
      if (!header || !/^Bearer\s+\S+$/i.test(header)) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      const principal = await identity.authenticate(header.replace(/^Bearer\s+/i, ''))
      if (!principal) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      if (principal.role !== 'admin' || principal.kind === 'api') return void res.status(403).json({ error: 'manager_admin_required' })
      res.locals.principal = principal; next()
    } catch { res.status(503).json({ error: 'session_transfer_unavailable' }) }
  })
  const run = (action: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { await action(req, res) } catch (error) {
      if (error instanceof MobileDeviceError) return res.status(error.status).json({ error: error.code })
      if (error instanceof ManagerError) return res.status(error.status).json({ error: 'manager_password_confirmation_failed' })
      res.status(503).json({ error: 'session_transfer_unavailable' })
    }
  }
  router.get('/backups', run(async (_req, res) => res.json(await (await runtime()).list())))
  router.post('/restore', json({ limit: '17mb' }), run(async (req, res) => res.status(201).json(await (await runtime()).restore(req.body))))
  router.post('/:phone/backup-tasks', run(async (req, res) => res.status(202).json(await (await runtime()).tasks.start(req.params.phone, req.body))))
  router.get('/:phone/backup-tasks/:task/download', run(async (req, res) => res.json(await (await runtime()).tasks.download(req.params.phone, req.params.task))))
  router.get('/:phone/transfer-removal', run(async (req, res) => res.json(await (await runtime()).eligibility(req.params.phone))))
  router.delete('/:phone/transfer-removal', run(async (req, res) => {
    const { password, ...body } = req.body || {}
    await identity.confirmAdminPassword(res.locals.principal, password, req.ip || 'unknown')
    await (await runtime()).remove(req.params.phone, body)
    res.sendStatus(204)
  }))
  return router
}
