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
  router.post('/restore-uploads', json({ limit: '4kb' }), run(async (req, res) => {
    res.status(201).json(await (await runtime()).multipart.start(res.locals.principal.id, req.body))
  }))
  router.get('/restore-uploads/:upload', run(async (req, res) => {
    res.json(await (await runtime()).multipart.status(res.locals.principal.id, req.params.upload))
  }))
  router.put('/restore-uploads/:upload/parts/:part', run(async (req, res) => {
    if (!req.is('application/octet-stream')) return void res.status(415).json({ error: 'session_backup_stream_required' })
    if (!/^(0|[1-9]\d*)$/.test(req.params.part)) return void res.status(400).json({ error: 'session_upload_part_invalid' })
    res.json(await (await runtime()).multipart.part(res.locals.principal.id, req.params.upload, Number(req.params.part), req.get('X-Part-SHA256') || '', req))
  }))
  router.post('/restore-uploads/:upload/complete', json({ limit: '4kb' }), run(async (req, res) => {
    res.status(202).json(await (await runtime()).multipart.complete(res.locals.principal.id, req.params.upload, req.body))
  }))
  router.delete('/restore-uploads/:upload', run(async (req, res) => {
    res.json(await (await runtime()).multipart.cancel(res.locals.principal.id, req.params.upload))
  }))
  router.post('/restore', json({ limit: '17mb' }), run(async (req, res) => res.status(201).json(await (await runtime()).restore(req.body))))
  router.post('/restore-stream', run(async (req, res) => {
    if (!req.is('application/octet-stream')) return void res.status(415).json({ error: 'session_backup_stream_required' })
    res.status(201).json(await (await runtime()).restoreStream(req))
  }))
  router.post('/:phone/backup-tasks', run(async (req, res) => res.status(202).json(await (await runtime()).tasks.start(req.params.phone, req.body))))
  router.get('/:phone/backup-tasks/:task/download', run(async (req, res) => {
    const value = await runtime()
    res.json(await (value.download ? value.download(req.params.phone, req.params.task) : value.tasks.download(req.params.phone, req.params.task)))
  }))
  router.get('/:phone/backup-tasks/:task/download/file', run(async (req, res) => {
    const file = await (await runtime()).downloadStream(req.params.phone, req.params.task)
    res.type('application/octet-stream').setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.on('close', () => file.stream.destroy())
    file.stream.on('error', () => { if (!res.headersSent) res.status(503).end(); else res.destroy() })
    file.stream.pipe(res)
  }))
  router.get('/:phone/transfer-removal', run(async (req, res) => res.json(await (await runtime()).eligibility(req.params.phone))))
  router.delete('/:phone/transfer-removal', run(async (req, res) => {
    const { password, ...body } = req.body || {}
    await identity.confirmAdminPassword(res.locals.principal, password, req.ip || 'unknown')
    await (await runtime()).remove(req.params.phone, body)
    res.sendStatus(204)
  }))
  return router
}
