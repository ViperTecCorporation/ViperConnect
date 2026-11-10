import type { Config } from '../config'
import type { DataStore } from '../data_store'
import { createProviderDataStoreBase } from '../data_store_base'
import { UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_QUEUE_NAME } from '../../defaults'
import { amqpConsume, amqpRpc } from '../../amqp'
import { SendError } from '../send_error'
import { SessionStorageError } from './types'
import { storageOwner, storageWireDecode, storageWireEncode, DATA_STORE_OPERATIONS, assertLocalStorageOwner } from './routing'
import { storageWorkerIdentity } from './capability'
import logger from '../logger'
import { assertStorageReadDeadline, storageReadTimeout } from './rpc_deadline'

const queue = (owner: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(owner)) throw new SendError(400, 'session_storage_invalid_owner')
  return `${UNOAPI_QUEUE_NAME}.session-storage.${owner}`
}

export async function sessionStorageRpc<T>(phone: string, config: Config, operation: string, args: unknown[] = []): Promise<T> {
  const owner = config.sessionStorage?.owner || config.server || 'server_1'
  const timeoutMs = storageReadTimeout(operation), requestedAt = Date.now()
  let response: any
  try { response = await amqpRpc(UNOAPI_EXCHANGE_BRIDGE_NAME, queue(owner), '', {
    phone, generation: config.sessionStorage?.generation || 0, operation, args: storageWireEncode(args),
    ...(operation.startsWith('standalone.') ? { targetOwner: owner } : {}),
    ...(timeoutMs ? { requestedAt, deadlineAt: requestedAt + timeoutMs } : {}),
  }, { type: 'direct', priority: 5, maxRetries: 0, ...(timeoutMs ? { timeoutMs } : {}) }) }
  catch (error) { if (error instanceof SendError) throw error; throw new SendError(503, 'session_storage_worker_unavailable') }
  if (response?.storageError) throw new SendError(response.status || 503, response.storageError)
  return storageWireDecode(response?.value) as T
}

export function remoteSessionDataStore(phone: string, config: Config): DataStore {
  const store = createProviderDataStoreBase()
  store.type = 'sqlite-remote'
  for (const name of DATA_STORE_OPERATIONS) (store as any)[name] = (...args: unknown[]) => sessionStorageRpc(phone, config, `data.${name}`, args)
  // These are metadata resolution helpers, never ship socket objects over AMQP.
  store.loadImageUrl = async jid => store.getImageUrl(jid)
  store.loadGroupMetada = async jid => store.getGroupMetada(jid)
  store.loadJid = async input => store.getJid(input)
  store.setJidIfNotFound = async (input, jid) => { if (!await store.getJid(input)) await store.setJid(input, jid) }
  store.cleanSession = async () => { throw new SendError(409, 'session_storage_cleanup_requires_owner') }
  return store
}

export async function handleSessionStorageRequest(request: any): Promise<any> {
  try {
    if (!/^\d{8,15}$/.test(request?.phone || '') || !Array.isArray(request.args) || request.args.length > 12) throw new SendError(400, 'session_storage_invalid_rpc')
    assertStorageReadDeadline(request)
    if (typeof request.operation === 'string' && request.operation.startsWith('standalone.')) {
      const { executeStandaloneWebOperation } = module.require('./standalone_web_worker') as typeof import('./standalone_web_worker')
      const value = await executeStandaloneWebOperation(request.phone, request.targetOwner, request.operation, storageWireDecode(request.args))
      return { value: storageWireEncode(value) }
    }
    const { getConfigRedis } = module.require('../config_redis.js') as typeof import('../config_redis')
    const config = await getConfigRedis(request.phone)
    const owner = config.sessionStorage?.owner || config.server || 'server_1'
    if (owner !== storageOwner()) throw new SendError(409, 'session_storage_wrong_owner')
    if ((config.sessionStorage?.generation || 0) !== request.generation) throw new SendError(409, 'session_storage_generation_changed')
    const args = storageWireDecode(request.args)
    assertStorageReadDeadline(request)
    let value: unknown
    if (request.operation === 'passkey.assertion' || request.operation === 'passkey.confirm') {
      const action = request.operation === 'passkey.assertion' ? 'assertion' : 'confirm'
      if (args.length !== (action === 'assertion' ? 2 : 1)) throw new SendError(400, 'passkey_bridge_invalid_operation')
      const { executePasskeyBridgeOperation } = module.require('../passkey_bridge_operation') as typeof import('../passkey_bridge_operation')
      value = await executePasskeyBridgeOperation(request.phone, config, action, args[0], args[1])
    } else if (request.operation.startsWith('data.')) {
      const name = request.operation.slice(5)
      if (!DATA_STORE_OPERATIONS.has(name)) throw new SendError(400, 'session_storage_invalid_operation')
      assertLocalStorageOwner(config)
      if (['migrating', 'restoring'].includes(config.sessionStorage?.state || '')) throw new SendError(409, 'session_storage_operation_in_progress')
      const { getDataStoreSqlite } = module.require('./data_store_sqlite.js') as typeof import('./data_store_sqlite')
      const data = await getDataStoreSqlite(request.phone, config)
      value = await (data as any)[name](...args)
    } else {
      const { executeStorageOperation } = module.require('./runtime.js') as typeof import('./runtime')
      value = await executeStorageOperation(request.phone, config, request.operation, args)
    }
    return { value: storageWireEncode(value) }
  } catch (error) {
    return { storageError: error instanceof SendError ? error.title : error instanceof SessionStorageError ? error.code : 'session_storage_unavailable',
      status: error instanceof SendError ? error.code : error instanceof SessionStorageError ? error.status : 503 }
  }
}

export async function startSessionStorageConsumer() {
  const identity = storageWorkerIdentity()
  if (!identity.valid) {
    logger.warn({ code: identity.reason }, 'Session storage consumer disabled: ambiguous worker identity')
    return { started: false, reason: identity.reason }
  }
  await amqpConsume(UNOAPI_EXCHANGE_BRIDGE_NAME, queue(storageOwner()), '',
    (_key: string, request: unknown) => handleSessionStorageRequest(request),
    { type: 'direct', prefetch: 1, priority: 5, notifyFailedMessages: false })
  return { started: true }
}
