import { Router, json } from 'express'
import { managerIdentity, ManagerIdentity, ManagerError } from '../services/manager_identity'
import { managerToken } from '../services/manager_access'
import { MobileDeviceService, MobileDeviceError, mobileCapabilities } from '../services/mobile_device_service'
import { createRegistrationService } from '../services/mobile_primary/registration_process'
import { companionOperations } from '../services/mobile_primary/companion_runtime'

export function mobileDeviceRouter(
  identity: Pick<ManagerIdentity, 'authenticate'> & Partial<Pick<ManagerIdentity, 'confirmAdminPassword'>> = managerIdentity,
  service = new MobileDeviceService(),
  enabled = () => process.env.UNOAPI_MOBILE_PRIMARY_LAB === 'true',
  registration = createRegistrationService(service),
  connection = async () => (await import('../services/mobile_primary/connection_runtime.js')).createMobileConnectionService(),
  deletion = async () => (await import('../services/mobile_primary/deletion_runtime.js')).createMobileDeletionService(),
  backup = async () => (await import('../services/mobile_primary/backup_runtime.js')).createMobileBackupService(),
  companions = companionOperations,
  history = async () => import('../services/mobile_primary/companion_history_runtime.js'),
  backupTasks = async () => (await import('../services/mobile_primary/backup_tasks.js')).createMobileBackupTasks(),
) {
  const router = Router()
  router.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!enabled()) return void res.status(404).json({ error: 'mobile_feature_disabled' })
    try {
      // New administrative endpoints accept bearer headers only, never URL/body tokens.
      if (typeof req.headers.authorization !== 'string' || !/^Bearer\s+\S+$/i.test(req.headers.authorization)) {
        return void res.status(401).json({ error: 'manager_invalid_credentials' })
      }
      const principal = await identity.authenticate(managerToken(req))
      if (!principal) return void res.status(401).json({ error: 'manager_invalid_credentials' })
      if (principal.role !== 'admin' || principal.kind === 'api') return void res.status(403).json({ error: 'manager_admin_required' })
      res.locals.mobileActor = principal.id
      res.locals.mobilePrincipal = principal
      next()
    } catch { res.status(503).json({ error: 'mobile_store_unavailable' }) }
  })
  const run = (action: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
    try { await action(req, res) } catch (error) {
      if (error instanceof MobileDeviceError) return res.status(error.status).json({ error: error.code })
      if (error instanceof ManagerError) return res.status(error.status).json({ error: 'manager_password_confirmation_failed' })
      return res.status(503).json({ error: 'mobile_store_unavailable' })
    }
  }
  router.post('/:id/companions', run(async (req, res) => res.status(202).json(await (await companions(req.params.id)).submit(req.body))))
  router.post('/:id/companion-history', run(async (req, res) => res.status(202).json(await (await history()).requestCompanionHistory(req.params.id, req.body))))
  router.get('/:id/companion-history/:operation', run(async (req, res) => res.json(await (await (await history()).companionHistoryService(req.params.id)).status(req.params.operation))))
  router.get('/:id/companions/:operation', run(async (req, res) => res.json(await (await companions(req.params.id)).status(req.params.operation))))
  router.get('/capabilities', (_req, res) => res.json({ ...mobileCapabilities(), smsRegistration: registration.enabled(), primaryConnection: process.env.UNOAPI_SERVER_NAME === 'mobile_lab', credentialImport: process.env.UNOAPI_SERVER_NAME === 'mobile_lab', companionQr: process.env.UNOAPI_SERVER_NAME === 'mobile_lab', companionCode: process.env.UNOAPI_SERVER_NAME === 'mobile_lab', reason: registration.enabled() ? 'mobile_registration_unverified' : 'mobile_registration_provider_unavailable' }))
  router.post('/restore', json({ limit: '17mb' }), run(async (req, res) => res.status(201).json(await (await backup()).restore(req.body, res.locals.mobileActor))))
  router.post('/:id/backup', run(async (req, res) => res.json(await (await backup()).export(req.params.id, req.body))))
  router.get('/backups', run(async (_req, res) => {
    const tasks = await backupTasks()
    res.json({ tasks: (await Promise.all((await service.list()).map(device => tasks.status(device.id)))).filter(Boolean) })
  }))
  router.post('/:id/backup-tasks', run(async (req, res) => res.status(202).json(await (await backupTasks()).start(req.params.id, req.body))))
  router.get('/:id/backup-tasks/:task/download', run(async (req, res) => res.json(await (await backupTasks()).download(req.params.id, req.params.task))))
  router.get('/:id/transfer-removal', run(async (req, res) => res.json(await (await deletion()).transferEligibility(req.params.id))))
  router.delete('/:id/transfer-removal', run(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => !['confirm', 'backupValidated', 'phone', 'password'].includes(key))) throw new MobileDeviceError(400, 'mobile_removal_confirmation_required')
    if (!identity.confirmAdminPassword) throw new MobileDeviceError(503, 'manager_password_confirmation_unavailable')
    const { password, ...confirmation } = req.body
    await identity.confirmAdminPassword(res.locals.mobilePrincipal, password, req.ip || 'unknown')
    await (await deletion()).remove(req.params.id, confirmation, true)
    res.sendStatus(204)
  }))
  router.get('/:id/registration', run(async (req, res) => res.json(await registration.status(req.params.id))))
  router.get('/:id/connection', run(async (req, res) => res.json(await (await connection()).status(req.params.id))))
  router.post('/:id/connection', run(async (req, res) => res.status(202).json(await (await connection()).connect(req.params.id, req.body))))
  router.post('/:id/registration/request', run(async (req, res) => res.json(await registration.execute(req.params.id, 'request', req.body))))
  router.post('/:id/registration/verify', run(async (req, res) => res.json(await registration.execute(req.params.id, 'verify', req.body))))
  router.get('/', run(async (_req, res) => res.json({ devices: await service.list() })))
  router.post('/', run(async (req, res) => res.status(201).json(await service.create(req.body, res.locals.mobileActor))))
  router.get('/:id', run(async (req, res) => res.json(await service.get(req.params.id))))
  router.delete('/:id', run(async (req, res) => {
    if (req.body?.confirm !== true || Object.keys(req.body).some(key => key !== 'confirm')) throw new MobileDeviceError(400, 'mobile_removal_confirmation_required')
    await service.remove(req.params.id)
    res.sendStatus(204)
  }))
  router.delete('/:id/full', run(async (req, res) => {
    await (await deletion()).remove(req.params.id, req.body)
    res.sendStatus(204)
  }))
  return router
}
