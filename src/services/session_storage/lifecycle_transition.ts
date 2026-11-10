import { randomUUID } from 'node:crypto'
import { configs, type Config, type getConfig } from '../config'
import { assertSessionEffectsAllowed } from './routing'
import { SessionStorageError } from './types'

/** Includes provider identity, not just the database generation. */
export const sessionLifecycleIdentity = (config: Config) => JSON.stringify([
  config.provider, config.server, config.mobilePrimaryDraftId,
  !!config.mobilePrimaryDeleting, config.sessionStorage ? [
    config.sessionStorage.backend, config.sessionStorage.storageId, config.sessionStorage.owner,
    config.sessionStorage.generation, config.sessionStorage.state, !!config.sessionStorage.fixture,
  ] : null,
])

/** Invalidate the configuration cache before crossing an asynchronous boundary. */
export async function readSessionLifecycleConfig(phone: string, read: getConfig, expected?: string) {
  const previous = configs.get(phone)
  configs.delete(phone)
  const current = await read(phone)
  assertSessionEffectsAllowed(current)
  if (expected !== undefined && sessionLifecycleIdentity(current) !== expected) {
    throw new SessionStorageError(409, 'session_storage_generation_changed')
  }
  // getConfigRedis normally preserves the active socket's metadata resolver on
  // cache refresh. Forced freshness must not accidentally replace it with the
  // default resolver, nor carry it across a different storage/provider identity.
  if (previous?.getMessageMetadata && sessionLifecycleIdentity(previous) === sessionLifecycleIdentity(current)) {
    current.getMessageMetadata = previous.getMessageMetadata
  }
  return current
}

export type LifecycleCheck = () => Promise<Config>
const RENEW = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('PEXPIRE',KEYS[1],ARGV[2])"
const RELEASE = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; return redis.call('DEL',KEYS[1])"

/** Same distributed reservation as migration/restore tasks; never remove another task's lock. */
export async function withSessionLifecycleTransition<T>(phone: string, read: getConfig,
  run: (config: Config, check: LifecycleCheck) => Promise<T>): Promise<T> {
  const config = await readSessionLifecycleConfig(phone, read)
  const expected = sessionLifecycleIdentity(config)
  const fresh = () => readSessionLifecycleConfig(phone, read, expected)
  if (config.provider !== 'zapo' || !config.useRedis) return run(config, fresh)
  const redis = await module.require('../redis').getRedis()
  const key = `unoapi-session-storage:task:lock:${phone}`, token = randomUUID(), ttl = '600000'
  if (await redis.set(key, token, { NX: true, PX: Number(ttl) }) !== 'OK') {
    throw new SessionStorageError(409, 'session_storage_operation_in_progress')
  }
  let lost = false
  const renew = async () => {
    if (Number(await redis.eval(RENEW, { keys: [key], arguments: [token, ttl] })) !== 1) lost = true
  }
  const timer = setInterval(() => { void renew().catch(() => { lost = true }) }, 30000)
  timer.unref?.()
  const check: LifecycleCheck = async () => {
    await renew()
    if (lost) throw new SessionStorageError(409, 'session_storage_task_lost')
    return fresh()
  }
  try { return await run(await check(), check) }
  finally {
    clearInterval(timer)
    await redis.eval(RELEASE, { keys: [key], arguments: [token] })
  }
}
