import type { Client, getClient } from '../client'
import { clients } from '../client'
import { ClientZapo } from '../client_zapo'
import { SendError } from '../send_error'
import { isZapoOwnershipConflict } from '../zapo/zapo_reconnect_policy'
import { resolveSessionProvider } from './provider_resolver'
import { isProviderRuntimeEnabled } from './provider_runtime_policy'
import { listenerForProvider } from './listener_selector'
import { readSessionLifecycleConfig } from '../session_storage/lifecycle_transition'
import { assertSessionConfigRegistered } from '../session_storage/connection_registration'

const pendingZapoClients = new Map<string, Promise<Client>>()
const LEGACY_BAILEYS_CLIENT_MODULE = '../client_baileys.js'

export const getClientProvider: getClient = async (args) => {
  const config = await readSessionLifecycleConfig(args.phone, args.getConfig)
  assertSessionConfigRegistered(config)
  const existing = clients.get(args.phone)
  if (existing) return existing
  if (resolveSessionProvider(config.provider) !== 'zapo') {
    if (!isProviderRuntimeEnabled(config.provider)) {
      throw new SendError(409, 'baileys_provider_disabled_deregister_required')
    }
    const { getClientBaileys } = await import(LEGACY_BAILEYS_CLIENT_MODULE)
    return getClientBaileys(args)
  }

  if (!config.autoConnect || config.mobilePrimaryDeleting) throw new SendError(409, 'session_storage_session_suspended')

  const pending = pendingZapoClients.get(args.phone)
  if (pending) return pending
  const creation = (async () => {
    const client = new ClientZapo(
      args.phone,
      listenerForProvider(args.listener, 'zapo'),
      args.getConfig,
      args.onNewLogin,
    )
    clients.set(args.phone, client)
    try {
      if (config.autoConnect && !config.mobilePrimaryDeleting) await client.connect(1)
    } catch (error) {
      if (isZapoOwnershipConflict(error)) throw error
      await client.disconnect().catch(() => undefined)
      if (clients.get(args.phone) === client) clients.delete(args.phone)
      throw error
    }
    return client as Client
  })()
  pendingZapoClients.set(args.phone, creation)
  try {
    return await creation
  } finally {
    pendingZapoClients.delete(args.phone)
  }
}
