import express from 'express'
import { createServer, Server as HttpServer } from 'http'
import { router } from './router'
import { getConfig } from './services/config'
import { Incoming } from './services/incoming'
import { Outgoing } from './services/outgoing'
import { SessionStore } from './services/session_store'
import middleware from './services/middleware'
import injectRoute from './services/inject_route'
import injectRouteDummy from './services/inject_route_dummy'
import type { OnNewLogin } from './services/login_types'
import { Server } from 'socket.io'
import { addToBlacklist } from './services/blacklist'
import cors from 'cors'
import { Reload } from './services/reload'
import { Logout } from './services/logout'
import { ContactDummy } from './services/contact_dummy'
import { Contact } from './services/contact'
import { middlewareNext } from './services/middleware_next'
import { UNOAPI_MESSAGES_JSON_LIMIT } from './defaults'

export class App {
  public readonly server: HttpServer
  public readonly socket: Server
  private app

  constructor(
    incoming: Incoming,
    outgoing: Outgoing,
    baseUrl: string,
    getConfig: getConfig,
    sessionStore: SessionStore,
    onNewLogin: OnNewLogin,
    addToBlacklist: addToBlacklist,
    reload: Reload,
    logout: Logout,
    middleware: middleware = middlewareNext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    injectRoute: injectRoute = injectRouteDummy,
    contact = new ContactDummy(),
  ) {
    this.app = express()
    this.app.use(cors({ origin: ['*'] }))
    // Media sent as Base64 is accepted only by message routes. Other JSON
    // endpoints keep Express' conservative default limit.
    this.app.use(
      /^\/[^/]+\/[^/]+\/(?:messages|marketing_messages)(?:\/[^/]+\/recover_delivery|\/recover_delivery)?\/?$/,
      express.json({ limit: UNOAPI_MESSAGES_JSON_LIMIT }),
    )
    const defaultJson = express.json()
    // Large backups are parsed only after manager authentication, inside the mobile router.
    this.app.use((req, res, next) => /^\/manager\/mobile-devices\/restore\/?$/.test(req.path) ? next() : defaultJson(req, res, next))
    this.app.use(express.urlencoded({ extended: true }))
    this.server = createServer(this.app)
    this.socket = new Server(this.server, {
      path: '/ws',
      cors: {
        origin: '*'
      }
    })
    this.router(
      incoming, 
      outgoing, 
      baseUrl, 
      getConfig,
      sessionStore,
      this.socket,
      onNewLogin,
      addToBlacklist, 
      reload, 
      logout,
      middleware, 
      injectRoute,
      contact,
    )
  }

  private router(
    incoming: Incoming,
    outgoing: Outgoing,
    baseUrl: string,
    getConfig: getConfig,
    sessionStore: SessionStore,
    socket: Server,
    onNewLogin: OnNewLogin,
    addToBlacklist: addToBlacklist,
    reload: Reload,
    logout: Logout,
    middleware: middleware,
    injectRoute: injectRoute,
    contact: Contact,
  ) {
    const roter = router(
      incoming, 
      outgoing, 
      baseUrl, 
      getConfig, 
      sessionStore, 
      socket, 
      onNewLogin, 
      addToBlacklist, 
      reload, 
      logout, 
      middleware, 
      injectRoute,
      contact,
    )
    this.app.use(roter)
  }
}
