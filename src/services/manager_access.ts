import type { Request, Response, NextFunction } from 'express'
import { managerIdentity, ManagerIdentity } from './manager_identity'
import { resolveSessionPhoneByMetaId } from './meta_alias'
import { UNOAPI_HEADER_NAME, UNOAPI_AUTH_TOKEN } from '../defaults'

export interface ManagerPrincipal {
  id: string
  role: 'admin' | 'user'
  username: string
  name: string
  phones: string[]
  kind: string
}

const principals = new WeakMap<Request, ManagerPrincipal>()
export const managerPrincipal = (req: Request): ManagerPrincipal | undefined => principals.get(req)
export const managerAdmin = (req: Request): boolean => managerPrincipal(req)?.role === 'admin'

export const managerToken = (req: Request): string => {
  const value = req.headers[UNOAPI_HEADER_NAME] || req.headers.authorization || req.query?.access_token ||
    req.query?.['hub.verify_token'] || req.body?.auth_token || req.body?.authToken || ''
  return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '').trim() : ''
}

// Never turn a personal credential into a reusable legacy/global credential.
const secretFields = new Set(['authtoken', 'auth_token', 'accesstoken', 'access_token', 'password', 'secret',
  'secretaccesskey', 'accesskeyid', 'apikey', 'api_key', 'openaiapikey', 'groqapikey', 'token', 'authorization', 'proxyurl', 'storage', 'basestore'])
export const redactManagerConfig = (value: any): any => {
  if (Array.isArray(value)) return value.map(redactManagerConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretFields.has(key.toLowerCase()))
    .map(([key, item]) => [key, redactManagerConfig(item)]))
}

/** Deny unscoped routes for personal credentials. Legacy credentials are intentionally unchanged. */
export const managerRequestScope = (path: string): string | 'list' | 'voip' | undefined => {
  if (path === '/sessions' || path === '/sessions/meta/mappings' || path === '/version') return 'list'
  if (/^\/v\d+\.\d+\/me\/whatsapp_business_accounts\/?$/.test(path)) return 'list'
  if (/^\/admin\/voip\//.test(path)) return 'voip' // Controllers verify resource ownership.
  const special = path.match(/^\/(?:connect|generate|sessions)\/(\d{8,15})\/?$/) ||
    path.match(/^\/admin\/webhooks\/history\/(\d{8,15})(?:\/restore)?\/?$/) ||
    path.match(/^\/(\d{8,15})\/(?:contacts|blacklist)(?:\/.*)?$/) ||
    path.match(/^\/timer\/(\d{8,15})\/[^/]+\/?$/) ||
    path.match(/^\/v\d+\.\d+\/download\/(\d{8,15})\/[^/]+\/?$/)
  if (special) return special[1]
  // The only unqualified media alias we accept includes its owning phone.
  const media = path.match(/^\/v\d+\.\d+\/(\d{8,15})-[A-Za-z0-9_-]+\/?$/)
  if (media) return media[1]
  const versioned = path.match(/^\/v\d+\.\d+\/(\d{8,20})(?:\/.*)?$/)
  return versioned?.[1]
}

export const managerAccess = (identity: Pick<ManagerIdentity, 'authenticate'> = managerIdentity,
  resolve = resolveSessionPhoneByMetaId) => async (req: Request, res: Response, next: NextFunction) => {
  const token = managerToken(req)
  const stackSessionList = !!UNOAPI_AUTH_TOKEN && token === UNOAPI_AUTH_TOKEN && /^\/sessions\/?$/.test(req.path)
  if (!token.startsWith('mgr_') && !stackSessionList) return next()
  try {
    const principal = await identity.authenticate(token) as ManagerPrincipal | undefined
    if (!principal) return void res.status(401).json({ error: 'manager_invalid_credentials' })
    principals.set(req, principal)
    res.locals.manager = principal
    // Existing controllers log headers. Do not let new credentials enter those logs.
    for (const field of [UNOAPI_HEADER_NAME, 'authorization']) if (req.headers[field]) req.headers[field] = '[manager-authenticated]'
    if (req.query?.access_token) req.query.access_token = '[manager-authenticated]'
    if (req.body?.auth_token) req.body.auth_token = '[manager-authenticated]'
    if (principal.role === 'admin') return next()
    const path = decodeURIComponent(req.path).replace(/\/$/, '') || '/'
    if (path.includes('..') || path.includes('\\') || path.includes('\0')) return void res.status(403).json({ error: 'manager_session_forbidden' })
    const scope = managerRequestScope(path)
    if (!scope) return void res.status(403).json({ error: 'manager_session_forbidden' })
    if (scope !== 'list' && scope !== 'voip') {
      const phone = await resolve(scope)
      if (!principal.phones.includes(phone)) return void res.status(403).json({ error: 'manager_session_forbidden' })
      res.locals.managerPhone = phone
    }
    if (/\/register\/?$/.test(path) && req.body && typeof req.body === 'object') {
      // Changing these would allow persistent access after an assignment is revoked.
      for (const field of ['authToken', 'auth_token', 'storage', 'baseStore', 'getStore', 'proxyUrl']) {
        if (req.body[field] !== undefined && req.body[field] !== '') return void res.status(403).json({ error: 'manager_admin_setting' })
        delete req.body[field]
      }
      // Secret inputs are not prefilled for restricted users. An empty field
      // must not erase an existing administrator-provided transcription key.
      for (const field of ['openaiApiKey', 'groqApiKey']) if (req.body[field] === '') delete req.body[field]
    }
    // Restrict redaction to configuration routes, never mutate user message content.
    if (scope === 'list' || /^\/v\d+\.\d+\/\d+(?:\/register|\/webhooks\/[^/]+)?\/?$/.test(path)) {
      const json = res.json.bind(res)
      res.json = ((body: any) => json(redactManagerConfig(body))) as typeof res.json
    }
    next()
  } catch {
    res.status(503).json({ error: 'manager_unavailable' })
  }
}
