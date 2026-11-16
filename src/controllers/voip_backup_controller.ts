import { Router, json } from 'express'
import { pipeline } from 'node:stream/promises'
import { managerIdentity } from '../services/manager_identity'
import { SessionStorageError } from '../services/session_storage/types'
import type { VoipBackups } from '../services/voip_backups'

export function voipBackupRouter(backend?: VoipBackups, identity = managerIdentity) {
  const router = Router(), service = () => backend || (module.require('../services/voip_backups') as typeof import('../services/voip_backups')).voipBackups
  router.use(json({ limit: '8kb' }))
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const header = req.headers.authorization
      if (!header || !/^Bearer\s+\S+$/i.test(header)) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      const principal = await identity.authenticate(header.replace(/^Bearer\s+/i, ''))
      if (!principal) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      if (principal.role !== 'admin' || principal.kind === 'api') return void res.status(403).json({ error: 'manager_admin_required' })
      next()
    } catch { res.status(503).json({ error: 'voip_backup_unavailable' }) }
  })
  const run = (action: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { const value = await action(req, res); if (!res.headersSent) res.json(value) }
    catch (error: any) {
      if (res.headersSent) return void res.destroy()
      const status = error instanceof SessionStorageError ? error.status : typeof error?.status === 'number' ? error.status : 503
      const message = error instanceof SessionStorageError ? error.code : /^voip_[a-z0-9_]+$/.test(error?.message || '') ? error.message : 'voip_backup_unavailable'
      res.status(status).json({ error: message })
    }
  }
  const confirm = (value: any, fields: string) => { if (!value || value.confirm !== true || Object.keys(value).sort().join(',') !== fields) throw new SessionStorageError(400, 'voip_backup_confirmation_required') }
  router.get('/', run(() => service().status()))
  router.post('/', run(req => { confirm(req.body, 'confirm'); return service().backup() }))
  router.post('/restore', run(req => { confirm(req.body, 'backupId,confirm'); return service().restore(req.body.backupId) }))
  router.post('/restore-upload', run(req => {
    if (req.query.confirm !== 'true' || Object.keys(req.query).join(',') !== 'confirm' || req.headers['content-type']?.split(';')[0] !== 'application/octet-stream'
      || !Number.isSafeInteger(Number(req.headers['content-length'])) || Number(req.headers['content-length']) < 1 || Number(req.headers['content-length']) > 256 * 1024 * 1024) throw new SessionStorageError(400, 'voip_backup_upload_invalid')
    return service().restore(undefined, req)
  }))
  router.get('/:id/download', run(async (req, res) => {
    const file = await service().download(req.params.id)
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', file.manifest.bytes)
    res.setHeader('Content-Disposition', `attachment; filename="voip-${file.manifest.id}.vipervoip"`)
    await pipeline(file.stream, res)
  }))
  return router
}
