import type { Config } from '../config'
import { assertLocalStorageOwner, isStorageWorker, storageOwner } from './routing'
import { SessionStorageError } from './types'
import { executeSessionStateCommands, SessionStateCommand } from './state_commands'
import type { MessageStatus } from '../data_store'

export { executeSessionStateCommands, sessionStateKeyOwner } from './state_commands'
export type { SessionStateCommand } from './state_commands'

type Batch = { expire(key: string, seconds: number): Batch; exec(): Promise<unknown[]> }
export interface SessionStateRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<string>
  del(key: string): Promise<number>
  exists(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number | boolean>
  pExpire(key: string, milliseconds: number): Promise<number | boolean>
  ttl(key: string): Promise<number>
  pTTL(key: string): Promise<number>
  hGet(key: string, field: string): Promise<string | null | undefined>
  hmGet(key: string, fields: string[]): Promise<(string | null)[]>
  hSet(key: string, field: string, value: string): Promise<number>
  hDel(key: string, fields: string | string[]): Promise<number>
  hKeys(key: string): Promise<string[]>
  hGetAll(key: string): Promise<Record<string, string>>
  zAdd(key: string, members: { score: number; value: string }[]): Promise<number>
  zCard(key: string): Promise<number>
  zScore(key: string, member: string): Promise<number | null>
  zRange(key: string, start: number, stop: number): Promise<string[]>
  zRangeByScore(key: string, minimum: number | string, maximum: number | string): Promise<string[]>
  zRem(key: string, members: string | string[]): Promise<number>
  zRemRangeByScore(key: string, minimum: number | string, maximum: number | string): Promise<number>
  sAdd(key: string, members: string | string[]): Promise<number>
  sMembers(key: string): Promise<string[]>
  sRem(key: string, members: string | string[]): Promise<number>
  sCard(key: string): Promise<number>
  scan(cursor: string | number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: string | number; keys: string[] }>
  multi(): Batch
  snapshotSet(key: string, value: string, options: { generation: string; ttlSeconds: number }): Promise<string | null>
  snapshotInvalidate(key: string, generation: string, options: { ttlSeconds: number; deleteSnapshot: boolean }): Promise<number>
  compareSet(key: string, expected: string | null, value: string): Promise<number>
  compareDelete(key: string, expected: string): Promise<number>
  retainedStatusSet(key: string, status: MessageStatus): Promise<string>
}

const methodNames = ['get', 'set', 'del', 'exists', 'expire', 'pExpire', 'ttl', 'pTTL', 'hGet', 'hmGet', 'hSet', 'hDel', 'hKeys', 'hGetAll',
  'zAdd', 'zCard', 'zScore', 'zRange', 'zRangeByScore', 'zRem', 'zRemRangeByScore', 'sAdd', 'sMembers', 'sRem', 'sCard', 'scan',
  'snapshotSet', 'snapshotInvalidate', 'compareSet', 'compareDelete', 'retainedStatusSet'] as const

/** Session data goes exclusively to its current backend; Redis remains the control plane. */
export async function getSessionStateRedis(phone: string): Promise<SessionStateRedis> {
  const { getRedis } = module.require('../redis') as typeof import('../redis')
  if (!/^[1-9]\d{7,14}$/.test(phone)) return await getRedis() as unknown as SessionStateRedis
  const { configs } = module.require('../config') as typeof import('../config')
  let config: Config | undefined = configs.get(phone)
  let raw: Awaited<ReturnType<typeof getRedis>> | undefined
  if (!config) {
    raw = await getRedis()
    const value = await raw.get(`unoapi-config:${phone}`)
    if (value) { try { config = JSON.parse(value) } catch { throw new SessionStorageError(503, 'session_storage_configuration_invalid') } }
  }
  if (config?.sessionStorage?.backend !== 'sqlite') return (raw || await getRedis()) as unknown as SessionStateRedis
  const selected = config
  const run = async (requests: SessionStateCommand[]): Promise<any[]> => {
    // Re-read cached selection for each call: a saved handle must not bypass a migration generation.
    const current = configs.get(phone) || selected
    if (current.sessionStorage?.backend !== 'sqlite' || current.sessionStorage.generation !== selected.sessionStorage!.generation
      || current.sessionStorage.storageId !== selected.sessionStorage!.storageId) throw new SessionStorageError(409, 'session_storage_generation_changed')
    if (isStorageWorker() && current.sessionStorage.owner === storageOwner()) {
      assertLocalStorageOwner(current)
      const { storageRoot } = module.require('./capability') as typeof import('./capability')
      return executeSessionStateCommands(phone, { ...current, baseStore: storageRoot() }, requests)
    }
    const { getConfigRedis } = module.require('../config_redis') as typeof import('../config_redis')
    const { sessionStorageRpc } = module.require('./rpc') as typeof import('./rpc')
    const fresh = await getConfigRedis(phone)
    if (fresh.sessionStorage?.backend !== 'sqlite' || fresh.sessionStorage.generation !== selected.sessionStorage!.generation
      || fresh.sessionStorage.storageId !== selected.sessionStorage!.storageId || fresh.sessionStorage.owner !== selected.sessionStorage!.owner) throw new SessionStorageError(409, 'session_storage_generation_changed')
    return sessionStorageRpc(phone, fresh, 'state.commands', [requests])
  }
  const port = Object.fromEntries(methodNames.map(command => [command, async (...args: unknown[]) => (await run([{ command, args }]))[0]])) as unknown as SessionStateRedis
  port.multi = () => {
    const pending: SessionStateCommand[] = []
    const batch: Batch = { expire: (key, seconds) => { pending.push({ command: 'expire', args: [key, seconds] }); return batch }, exec: () => run(pending) }
    return batch
  }
  return port
}
