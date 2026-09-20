import { UNOAPI_HEADER_NAME, UNOAPI_AUTH_TOKEN } from '../defaults'
import { Request, Response, NextFunction } from 'express'
import logger from './logger'
import { SessionStore } from './session_store'
import { isEmbeddedAccessToken } from './embedded_tokens'
import { resolveSessionPhoneByMetaId } from './meta_alias'
import { managerPrincipal } from './manager_access'


export default class Security {
  private sessionStore: SessionStore

  constructor(sessionStore: SessionStore){
    this.sessionStore = sessionStore
  }

  public async run(req: Request, res: Response, next: NextFunction) {
    // Set only by the authenticated Manager gate, after scope verification.
    if (managerPrincipal(req)) return next()
    // Allow embedded signup endpoints without auth (public)
    try {
      const path = req.path || ''
      if (path.startsWith('/embedded')) return next()
    } catch {}
    const rawPhone = req.params.phone || req.params.session || req.params.phone_number_id || req.params.business_account_id || '*'
    logger.debug('Verifing client authentication...')
    if (UNOAPI_AUTH_TOKEN) {
      const httpAuthToken = `${getAuthHeaderToken(req).trim()}`
      if (!httpAuthToken) {
        const message = `Please set Header ${UNOAPI_HEADER_NAME} query params or Authorization header`
        logger.warn(message)
        logger.debug('method %s', req.method)
        logger.debug('headers %s', JSON.stringify(req.headers))
        logger.debug('params %s', JSON.stringify(req.params))
        logger.debug('body %s', JSON.stringify(req.body))
        logger.debug('query %s', JSON.stringify(req.query))
        res.status(401).json({
          error: {
            code: 0,
            title: message,
          },
        })
      } else {
        if (httpAuthToken === UNOAPI_AUTH_TOKEN) {
          logger.debug('Authenticated by UNOAPI_AUTH_TOKEN')
          return next()
        }
        if (isEmbeddedAccessToken(httpAuthToken)) {
          logger.debug('Authenticated by embedded access token')
          return next()
        }
        const phone = rawPhone === '*' ? rawPhone : await resolveSessionPhoneByMetaId(rawPhone)
        const tokens = await this.sessionStore.getTokens(phone)
        const allTokens = [UNOAPI_AUTH_TOKEN, ...tokens]
        if (!allTokens.includes(httpAuthToken)) {
          const message = 'Invalid token value'
          logger.debug('method %s', req.method)
          logger.debug('headers %s', JSON.stringify(req.headers))
          logger.debug('params %s', JSON.stringify(req.params))
          logger.debug('body %s', JSON.stringify(req.body))
          logger.debug('query %s', JSON.stringify(req.query))
          logger.warn(message)
          res.status(403).json({
            error: {
              code: 10,
              title: message,
            },
          })
        } else {
          logger.debug('Authenticated!')
          next()
        }
      }
    } else {
      next()
    }
  }
}

export const getAuthHeaderToken = (req: Request) => {
  const headerName = UNOAPI_HEADER_NAME
  const value = (
    req.headers[headerName] ||
    req.headers['authorization'] ||
    req.query['access_token'] ||
    req.query['hub.verify_token'] ||
    req.headers['Authorization'] ||
    req.body?.['auth_token'] ||
    req.body?.['authToken'] ||
    ''
  )
  return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : ''
}
