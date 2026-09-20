import { Router, Request, Response } from 'express'
import { managerIdentity, ManagerIdentity, ManagerError } from '../services/manager_identity'
import { managerToken } from '../services/manager_access'

/** Dedicated identity endpoints; ordinary session credentials cannot administer accounts. */
export const managerRouter = (identity: ManagerIdentity = managerIdentity) => {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  const run = (action: (req: Request, res: Response, principal?: any) => Promise<any>, admin = false, login = false) =>
    async (req: Request, res: Response) => {
      try {
        const principal = login ? undefined : await identity.authenticate(managerToken(req))
        if (!login && !principal) return res.status(401).json({ error: 'manager_invalid_credentials' })
        if (principal?.kind === 'api' && req.path !== '/me') return res.status(403).json({ error: 'manager_login_required' })
        if (admin && principal?.role !== 'admin') return res.status(403).json({ error: 'manager_admin_required' })
        return await action(req, res, principal)
      } catch (error) {
        if (error instanceof ManagerError) return res.status(error.status).json({ error: error.message, ...error.details })
        return res.status(503).json({ error: 'manager_unavailable' })
      }
    }
  router.post('/login', run(async (req, res) => res.json(await identity.login(req.body?.username, req.body?.password, req.ip || 'unknown')), false, true))
  router.get('/me', run(async (_req, res, p) => res.json({ user: { id: p.id, username: p.username, name: p.name, role: p.role } })))
  router.post('/logout', run(async (req, res) => { await identity.logout(managerToken(req)); return res.sendStatus(204) }))
  router.get('/users', run(async (_req, res) => res.json({ users: await identity.users() }), true))
  router.post('/users', run(async (req, res) => res.status(201).json(await identity.createUser(req.body)), true))
  router.patch('/users/:id', run(async (req, res) => res.json(await identity.updateUser(req.params.id, req.body)), true))
  router.post('/users/:id/revoke-keys', run(async (req, res) => { await identity.revokeKeys(req.params.id); return res.sendStatus(204) }, true))
  router.get('/assignments', run(async (_req, res) => res.json(await identity.assignments()), true))
  router.put('/assignments/:phone', run(async (req, res, p) => {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'expected_owner') || !Object.prototype.hasOwnProperty.call(req.body, 'user_id')) {
      return res.status(400).json({ error: 'manager_assignment_confirmation_required' })
    }
    await identity.assign(req.params.phone, req.body.user_id, req.body.expected_owner, p.id)
    return res.json({ success: true })
  }, true))
  router.get('/keys', run(async (_req, res, p) => res.json({ keys: await identity.keys(p.id) })))
  router.post('/keys', run(async (req, res, p) => {
    if (p.role === 'admin') return res.status(403).json({ error: 'manager_admin_uses_stack_token' })
    return res.status(201).json(await identity.createKey(p.id, req.body))
  }))
  router.delete('/keys/:id', run(async (req, res, p) => { await identity.revokeKey(p.id, req.params.id); return res.sendStatus(204) }))
  router.post('/password', run(async (req, res, p) => {
    if (p.role === 'admin') return res.status(403).json({ error: 'manager_admin_uses_stack_token' })
    await identity.changePassword(p.id, req.body?.current_password, req.body?.password)
    return res.sendStatus(204)
  }))
  return router
}
