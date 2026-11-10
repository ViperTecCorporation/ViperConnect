import { Router } from 'express'
import { managerIdentity } from '../services/manager_identity'
import { SessionStorageError } from '../services/session_storage/types'
import type { Readable } from 'node:stream'

export interface StorageRestoreGateway {
  workers(): Promise<unknown>
  upload(phone: string, owner: string, stream: Readable, bytes: number): Promise<unknown>
  task(phone: string, id: string): Promise<unknown>
  backups(phone: string): Promise<unknown>
  download(phone: string, id: string): Promise<{ stream: Readable; fileName: string }>
}
const gateway: StorageRestoreGateway = {
  workers: () => module.require('../services/session_storage/standalone_web').restoreWorkerDirectory(),
  upload: (...args) => module.require('../services/session_storage/standalone_web').uploadStandaloneBackup(...args),
  task: async (phone, id) => {
    const { getRedis } = module.require('../services/redis') as typeof import('../services/redis')
    const { StandaloneWebTasks } = module.require('../services/session_storage/standalone_web_tasks') as typeof import('../services/session_storage/standalone_web_tasks')
    return new StandaloneWebTasks(await getRedis()).status(phone, id)
  },
  backups: phone => module.require('../services/session_storage/standalone_web').sessionBackupLibrary(phone),
  download: (phone, id) => module.require('../services/session_storage/standalone_web').downloadSessionBackup(phone, id),
}

/** Global administrative entry: restore into an absent session, without implicit registration. */
export function storageRestoreRouter(service = gateway, identity = managerIdentity) {
  const router = Router()
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const header = req.headers.authorization
      if (!header || !/^Bearer\s+\S+$/i.test(header)) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      const principal = await identity.authenticate(header.replace(/^Bearer\s+/i, ''))
      if (!principal) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      if (principal.role !== 'admin' || principal.kind === 'api') return void res.status(403).json({ error: 'manager_admin_required' })
      next()
    } catch { res.status(503).json({ error: 'session_storage_unavailable' }) }
  })
  const run = (action: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { await action(req, res) }
    catch (error) { if (!res.headersSent) res.status(error instanceof SessionStorageError ? error.status : 503).json({ error: error instanceof SessionStorageError ? error.code : 'session_storage_unavailable' }); else res.destroy() }
  }
  router.get('/workers', run(async (_req, res) => res.json(await service.workers())))
  router.post('/restore-upload', run(async (req, res) => {
    if (req.query.confirmOriginOffline !== 'true' || req.query.mode !== 'offline' || typeof req.query.phone !== 'string' || typeof req.query.owner !== 'string'
      || Object.keys(req.query).sort().join(',') !== 'confirmOriginOffline,mode,owner,phone' || !req.is('application/octet-stream')) throw new SessionStorageError(400, 'session_storage_standalone_confirmation_required')
    res.status(202).json(await service.upload(req.query.phone, req.query.owner, req, Number(req.headers['content-length'])))
  }))
  router.get('/restores/:phone/:id', run(async (req, res) => res.json(await service.task(req.params.phone, req.params.id))))
  router.get('/:phone/backups', run(async (req, res) => res.json(await service.backups(req.params.phone))))
  router.get('/:phone/backups/:id/download', run(async (req, res) => {
    const file = await service.download(req.params.phone, req.params.id)
    res.type('application/octet-stream').setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.on('close', () => file.stream.destroy())
    file.stream.on('error', () => { if (!res.headersSent) res.status(503).end(); else res.destroy() })
    file.stream.pipe(res)
  }))
  return router
}
