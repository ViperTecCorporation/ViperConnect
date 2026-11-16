import { Router, json } from 'express'
import type { Readable } from 'node:stream'
import { managerIdentity } from '../services/manager_identity'
import { SessionStorageError, validateSessionPhone } from '../services/session_storage/types'
import { validateExplorerQuery } from '../services/session_storage/explorer'

export interface SessionStorageGateway {
  status(phone: string): Promise<unknown>
  migrate(phone: string, body: unknown): Promise<unknown>
  task(phone: string, taskId: string): Promise<unknown>
  backup(phone: string, body: unknown): Promise<unknown>
  restore(phone: string, body: unknown): Promise<unknown>
  sourceCleanup?(phone: string, body: unknown): Promise<unknown>
  metrics?(phone: string): Promise<unknown>
  explore?(phone: string, query: unknown): Promise<unknown>
  mutate?(phone: string, body: unknown): Promise<unknown>
  restoreUpload?(phone: string, source: Readable, bytes: number): Promise<unknown>
}

/** Mounted under manager; every operation is admin-only and dispatched to the owner. */
export function sessionStorageRouter(gateway: SessionStorageGateway, identity = managerIdentity) {
  const router = Router()
  router.use((req, _res, next) => /^\/\d{8,15}\/storage(?:\/|$)/.test(req.path) ? next() : next('router'))
  router.use(json({ limit: '128kb' }))
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
  const run = (action: (req: any) => Promise<unknown>, accepted = false) => async (req: any, res: any) => {
    try { validateSessionPhone(req.params.phone); res.status(accepted ? 202 : 200).json(await action(req)) }
    catch (error) { if (error instanceof SessionStorageError) res.status(error.status).json({ error: error.code }); else res.status(503).json({ error: 'session_storage_unavailable' }) }
  }
  router.get('/:phone/storage', run(req => gateway.status(req.params.phone)))
  router.get('/:phone/storage/metrics', run(req => {
    if (!gateway.metrics) throw new SessionStorageError(503, 'session_storage_metrics_unavailable')
    return gateway.metrics(req.params.phone)
  }))
  router.get('/:phone/storage/explorer', run(req => {
    if (!gateway.explore) throw new SessionStorageError(503, 'session_storage_explorer_unavailable')
    return gateway.explore(req.params.phone, validateExplorerQuery(req.query))
  }))
  router.post('/:phone/storage/explorer', run(req => {
    if (!gateway.mutate) throw new SessionStorageError(503, 'session_storage_explorer_unavailable')
    const { validateExplorerMutation } = module.require('../services/session_storage/explorer_mutations') as typeof import('../services/session_storage/explorer_mutations')
    return gateway.mutate(req.params.phone, validateExplorerMutation(req.body))
  }))
  router.post('/:phone/storage/migrations', run(req => {
    if (!req.body || req.body.target !== 'sqlite' || req.body.confirm !== true || Object.keys(req.body).sort().join(',') !== 'confirm,target') throw new SessionStorageError(400, 'session_storage_confirmation_required')
    return gateway.migrate(req.params.phone, req.body)
  }, true))
  router.get('/:phone/storage/tasks/:taskId', run(req => gateway.task(req.params.phone, req.params.taskId)))
  router.post('/:phone/storage/backups', run(req => {
    if (!req.body || req.body.confirm !== true || Object.keys(req.body).join(',') !== 'confirm') throw new SessionStorageError(400, 'session_storage_confirmation_required')
    return gateway.backup(req.params.phone, req.body)
  }, true))
  router.post('/:phone/storage/source-cleanup', run(req => {
    if (!gateway.sourceCleanup) throw new SessionStorageError(409, 'session_storage_cleanup_unavailable')
    if (!req.body || req.body.confirm !== true || typeof req.body.backupId !== 'string' || !Number.isSafeInteger(req.body.generation) || Object.keys(req.body).sort().join(',') !== 'backupId,confirm,generation') throw new SessionStorageError(400, 'session_storage_confirmation_required')
    return gateway.sourceCleanup(req.params.phone, req.body)
  }, true))
  router.post('/:phone/storage/restores', run(req => {
    if (!req.body || req.body.confirm !== true || req.body.mode !== 'offline' || typeof req.body.backupId !== 'string' || Object.keys(req.body).sort().join(',') !== 'backupId,confirm,mode') throw new SessionStorageError(400, 'session_storage_restore_confirmation_required')
    return gateway.restore(req.params.phone, req.body)
  }, true))
  router.post('/:phone/storage/restore-upload', run(req => {
    if (!gateway.restoreUpload) throw new SessionStorageError(503, 'session_storage_upload_unavailable')
    if (req.query.confirm !== 'true' || req.query.mode !== 'offline' || Object.keys(req.query).sort().join(',') !== 'confirm,mode'
      || req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new SessionStorageError(400, 'session_storage_restore_confirmation_required')
    return gateway.restoreUpload(req.params.phone, req, Number(req.headers['content-length']))
  }, true))
  return router
}
