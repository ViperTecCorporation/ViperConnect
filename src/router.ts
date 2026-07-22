import express, { Router } from 'express'
import path from 'path'
import { Incoming } from './services/incoming'
import { Outgoing } from './services/outgoing'
import { getConfig } from './services/config'
import middleware from './services/middleware'
import { SessionStore } from './services/session_store'
import injectRoute from './services/inject_route'
import injectRouteDummy from './services/inject_route_dummy'
import { indexController } from './controllers/index_controller'
import { WebhookController } from './controllers/webhook_controller'
import { WebhookFakeController } from './controllers/webhook_fake_controller'
import { ContactsController } from './controllers/contacts_controller'
import { TemplatesController } from './controllers/templates_controller'
import { MessagesController } from './controllers/messages_controller'
import { MarketingMessagesController } from './controllers/marketing_messages_controller'
import { MediaController } from './controllers/media_controller'
import { PhoneNumberController } from './controllers/phone_number_controller'
import { RegistrationController } from './controllers/registration_controller'
import { SessionController } from './controllers/session_controller'
import { BlacklistController } from './controllers/blacklist_controller'
import { PairingCodeController } from './controllers/pairing_code_controller'
import { ConnectController } from './controllers/connect_controller'
import { Server } from 'socket.io'
import { OnNewLogin } from './services/socket'
import { addToBlacklist } from './services/blacklist'
import { Reload } from './services/reload'
import { Logout } from './services/logout'
import { Contact } from './services/contact'
import { ContactDummy } from './services/contact_dummy'
import { middlewareNext } from './services/middleware_next'
import { TimerController } from './controllers/timer_controller'
import { PreflightController } from './controllers/preflight_controller'
import { EmbeddedController } from './controllers/embedded_controller'
import { GroupsController } from './controllers/groups_controller'
import { PasskeyBridgeController } from './controllers/passkey_bridge_controller'
import { ZapoContactDirectory } from './services/zapo/zapo_contact_directory'


export const router = (
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
  middleware: middleware = middlewareNext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  injectRoute: injectRoute = injectRouteDummy,
  contact: Contact = new ContactDummy(),
) => {
  const router: Router = Router()
  const messagesController = new MessagesController(incoming, outgoing)
  const marketingMessagesController = new MarketingMessagesController(incoming, outgoing)
  const mediaController = new MediaController(baseUrl, getConfig, sessionStore)
  const templatesController = new TemplatesController(getConfig)
  const registrationController = new RegistrationController(getConfig, reload, logout)
  const phoneNumberController = new PhoneNumberController(getConfig, sessionStore, incoming)
  const sessionController = new SessionController(getConfig, reload)
  const webhookController = new WebhookController(outgoing, getConfig)
  const blacklistController = new BlacklistController(addToBlacklist)
  const contactsController = new ContactsController(contact, new ZapoContactDirectory(getConfig))
  const preflightController = new PreflightController(getConfig, contact)
  const groupsController = new GroupsController(incoming, outgoing, contact)
  const embeddedController = new EmbeddedController()
  const passkeyBridgeController = new PasskeyBridgeController(getConfig)
  const pairingCodeController = new PairingCodeController(incoming)
  const connectController = new ConnectController(reload)
  const timerController = new TimerController()


  // Webhook (Cloud API) roteado por phone_number_id
  router.post('/webhooks/whatsapp', webhookController.whatsappNoParam.bind(webhookController))
  router.get('/webhooks/whatsapp', webhookController.whatsappVerifyNoParam.bind(webhookController))
  // Compat: rota antiga por sessão (mantida para testes/compatibilidade)
  router.post('/webhooks/whatsapp/:phone', webhookController.whatsapp.bind(webhookController))
  router.get('/webhooks/whatsapp/:phone', webhookController.whatsappVerify.bind(webhookController))

  // for default webhook
  const webhookFakeController = new WebhookFakeController()
  router.post('/webhooks/fake/:phone', webhookFakeController.fake.bind(webhookFakeController))

  //Routes
  router.get('/', indexController.root)
  router.get('/index.html', indexController.root)
  router.get('/socket.io.min.js', indexController.socket)
  router.get('/favicon.ico', indexController.favicon)
  router.get('/docs', indexController.docs)
  router.get('/docs/openapi.html', indexController.docsOpenapiHtml)
  router.get('/docs/swagger.html', indexController.docsSwaggerHtml)
  // Specific JSON endpoints first, then wildcard for markdown/static files
  router.get('/docs/swagger.json', indexController.docsOpenApiJson)
  router.get('/docs/openapi.json', indexController.docsOpenApiJson)
  router.get('/docs/*', indexController.docsFile)
  router.get('/logos/*', indexController.logos)
  // Embedded Signup helpers (precisa ficar antes das rotas parametrizadas)
  router.get('/embedded/config.js', embeddedController.configJs.bind(embeddedController))
  router.post('/embedded/exchange', express.json(), embeddedController.exchange.bind(embeddedController))
  router.get('/:version/oauth/access_token', embeddedController.oauthAccessToken.bind(embeddedController))
  router.get('/embedded-callback.html', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'embedded-callback.html')))
  // Alias para evitar rota errada (config.js)
  router.get('/config.js', embeddedController.configJs.bind(embeddedController))
  router.get('/:version/config.js', embeddedController.configJs.bind(embeddedController))
  router.get('/connect/:phone', connectController.index.bind(connectController))
  router.get('/passkey-bridge/pending', passkeyBridgeController.pendingLatest.bind(passkeyBridgeController))
  router.get('/passkey-bridge/:bridgeId/pending', passkeyBridgeController.pending.bind(passkeyBridgeController))
  router.get('/passkey-bridge/:bridgeId/status', passkeyBridgeController.status.bind(passkeyBridgeController))
  router.post('/passkey-bridge/:bridgeId/assertion', passkeyBridgeController.assertion.bind(passkeyBridgeController))
  router.post('/passkey-bridge/:bridgeId/confirm', passkeyBridgeController.confirm.bind(passkeyBridgeController))
  router.delete('/passkey-bridge/:bridgeId', passkeyBridgeController.cancel.bind(passkeyBridgeController))
  router.get('/ping', indexController.ping)
  router.get('/:version/debug_token', phoneNumberController.debugToken.bind(phoneNumberController))
  router.get('/:version/me/whatsapp_business_accounts', middleware, phoneNumberController.whatsappBusinessAccounts.bind(phoneNumberController))
  // Meta-like endpoint para Typebot: /v17.0/{phone}-{mediaId} (colocado antes de /:version/:phone para evitar conflito)
  router.get('/:version/:media_id(\\d+-[A-Za-z0-9_-]+)', middleware, mediaController.typebot.bind(mediaController))
  // Graph media endpoint alias: /vXX.X/{media_id} (falls through when not found)
  router.get('/:version/:media_id([A-Za-z0-9_-]{8,})', middleware, mediaController.indexNoPhone.bind(mediaController))
  router.get('/sessions', middleware, phoneNumberController.list.bind(phoneNumberController))
  // Administrative helper: resolved Meta IDs per session (auth required)
  router.get('/sessions/meta/mappings', middleware, phoneNumberController.metaMappings.bind(phoneNumberController))
  router.get('/sessions/:phone', sessionController.index.bind(sessionController))
  router.get('/:phone/contacts', middleware, contactsController.get.bind(contactsController))
  router.post('/:phone/contacts', middleware, contactsController.post.bind(contactsController))
  router.post('/:version/:phone/register', middleware, registrationController.register.bind(registrationController))
  router.post('/:version/:phone/deregister', middleware, registrationController.deregister.bind(registrationController))
  router.patch('/:version/:phone/webhooks/:webhook_id', middleware, registrationController.updateWebhook.bind(registrationController))
  router.get('/:version/:phone', middleware, phoneNumberController.get.bind(phoneNumberController))
  // https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers/
  router.get('/:version/:business_account_id/subscribed_apps', middleware, phoneNumberController.subscribedApps.bind(phoneNumberController))
  router.post('/:version/:business_account_id/subscribed_apps', middleware, phoneNumberController.subscribedApps.bind(phoneNumberController))
  router.delete('/:version/:business_account_id/subscribed_apps', middleware, phoneNumberController.subscribedApps.bind(phoneNumberController))
  router.get('/:version/:business_account_id/phone_numbers', middleware, phoneNumberController.list.bind(phoneNumberController))
  router.get('/:version/:phone/phone_numbers', middleware, phoneNumberController.list.bind(phoneNumberController))
  router.post('/:version/:phone/debug/app_state_resync', middleware, phoneNumberController.resyncAppState.bind(phoneNumberController))
  router.post('/:version/:phone/debug/history_on_demand', middleware, phoneNumberController.historyOnDemand.bind(phoneNumberController))
  router.get('/:version/:phone/debug/privacy_tokens', middleware, phoneNumberController.privacyTokens.bind(phoneNumberController))
  router.post('/:version/:phone/debug/privacy_tokens', middleware, phoneNumberController.privacyTokens.bind(phoneNumberController))
  router.post('/:version/:phone/debug/privacy_bootstrap_sync', middleware, phoneNumberController.privacyBootstrapSync.bind(phoneNumberController))
  router.post('/:version/:phone/debug/auth_cache/prune', middleware, phoneNumberController.pruneAuthCache.bind(phoneNumberController))
  router.get('/:version/:business_account_id/message_templates', middleware, templatesController.index.bind(templatesController))
  router.post('/:version/:business_account_id/message_templates', middleware, templatesController.templates.bind(templatesController))
  router.delete('/:version/:business_account_id/message_templates/:templateId', middleware, templatesController.destroy.bind(templatesController))
  router.get('/:version/:phone/message_templates', middleware, templatesController.index.bind(templatesController))
  // JIDMAP endpoints (must come before '/:version/:phone/:media_id')
  try {
    const { JidMapController } = require('./controllers/jidmap_controller')
    const jidmap = new JidMapController()
    router.get('/:version/:phone/jidmap', middleware, jidmap.list.bind(jidmap))
    router.get('/:version/:phone/jidmap/:contact', middleware, jidmap.lookup.bind(jidmap))
  } catch {}
  router.post('/:version/:phone/templates', middleware, templatesController.templates.bind(templatesController))
  router.delete('/:version/:phone/templates/:templateId', middleware, templatesController.destroy.bind(templatesController))
  router.post('/:version/:phone_number_id/messages/:messageId/recover_delivery', middleware, messagesController.recoverDelivery.bind(messagesController))
  router.post('/:version/:phone/messages/:messageId/recover_delivery', middleware, messagesController.recoverDelivery.bind(messagesController))
  router.post('/:version/:phone_number_id/messages/recover_delivery', middleware, messagesController.recoverDelivery.bind(messagesController))
  router.post('/:version/:phone/messages/recover_delivery', middleware, messagesController.recoverDelivery.bind(messagesController))
  router.post('/:version/:phone_number_id/messages', middleware, messagesController.index.bind(messagesController))
  router.post('/:version/:phone/messages', middleware, messagesController.index.bind(messagesController))
  router.post('/:version/:phone/preflight/status', middleware, preflightController.status.bind(preflightController))
  router.get('/:version/:phone/groups', middleware, groupsController.list.bind(groupsController))
  router.post('/:version/:phone/groups', middleware, groupsController.create.bind(groupsController))
  router.get('/:version/:phone/groups/:groupId/participants', middleware, groupsController.participants.bind(groupsController))
  router.post('/:version/:phone/groups/:groupId/participants', middleware, groupsController.addParticipants.bind(groupsController))
  router.delete('/:version/:phone/groups/:groupId/participants', middleware, groupsController.removeParticipants.bind(groupsController))
  router.get('/:version/:phone/groups/:groupId/invite_link', middleware, groupsController.inviteLink.bind(groupsController))
  router.get('/:version/:phone/groups/:groupId/invite-link', middleware, groupsController.inviteLink.bind(groupsController))
  router.post('/:version/:phone/groups/:groupId/invite_link', middleware, groupsController.resetInviteLink.bind(groupsController))
  router.post('/:version/:phone/groups/:groupId/invite-link', middleware, groupsController.resetInviteLink.bind(groupsController))
  router.get('/:version/:phone/groups/:groupId/join_requests', middleware, groupsController.joinRequests.bind(groupsController))
  router.post('/:version/:phone/groups/:groupId/join_requests', middleware, groupsController.approveJoinRequests.bind(groupsController))
  router.delete('/:version/:phone/groups/:groupId/join_requests', middleware, groupsController.rejectJoinRequests.bind(groupsController))
  router.get('/:version/:phone/groups/:groupId', middleware, groupsController.details.bind(groupsController))
  router.post('/:version/:phone/groups/:groupId', middleware, groupsController.update.bind(groupsController))
  router.patch('/:version/:phone/groups/:groupId', middleware, groupsController.update.bind(groupsController))
  router.delete('/:version/:phone/groups/:groupId', middleware, groupsController.destroy.bind(groupsController))
  router.post('/:version/:phone/marketing_messages', middleware, marketingMessagesController.index.bind(marketingMessagesController))
  router.get('/:version/:phone/:media_id', middleware, mediaController.index.bind(mediaController))
  router.get('/:version/download/:phone/:file', middleware, mediaController.download.bind(mediaController))
  router.post('/:phone/blacklist/:webhook_id', middleware, blacklistController.update.bind(blacklistController))

  // https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers/
  router.post('/:phone/request_code', middleware, pairingCodeController.request.bind(pairingCodeController))

  // when session send reply, wait timeout to send message
  router.post('/timer/:phone/:to', middleware, timerController.start.bind(timerController))
  // when client reply, stop timer
  router.delete('/timer/:phone/:to', middleware, timerController.stop.bind(timerController))

  injectRoute(router)

  return router
}
