import NodeCache from 'node-cache'
import { amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BLACKLIST_ADD } from '../defaults'
import { blacklist, redisGet, setBlacklistAliases } from './redis'
import { blacklistTargets, resolveBlacklistAliases } from './blacklist_identity'

const DATA = new NodeCache()

export interface addToBlacklist {
  (from: string, webhookId: string, to: string, ttl: number): Promise<boolean>
}

export interface isInBlacklist {
  (from: string, webhookId: string, payload: object): Promise<string>
}

export const blacklistInMemory = (from: string, webhookId: string, to: string) => {
  return `${from}:${webhookId}:${to}`
}

export const isInBlacklistInMemory: isInBlacklist = async (from: string, webhookId: string, payload: object) => {
  const aliases = await resolveBlacklistAliases(from, blacklistTargets(payload))
  return aliases.find(to => DATA.has(blacklistInMemory(from, webhookId, to))) || ''
}

export const addToBlacklistInMemory: addToBlacklist = async (from: string, webhookId: string, to: string, ttl: number) => {
  const aliases = await resolveBlacklistAliases(from, [to])
  for (const alias of aliases) {
    const key = blacklistInMemory(from, webhookId, alias)
    if (ttl === 0) DATA.del(key)
    else DATA.set(key, alias, ttl > 0 ? ttl : 0)
  }
  return true
}

export const cleanBlackList = async () => {
  DATA.flushAll()
}

export const isInBlacklistInRedis: isInBlacklist = async (from: string, webhookId: string, payload: object) => {
  const aliases = await resolveBlacklistAliases(from, blacklistTargets(payload))
  // Redis is authoritative across broker replicas. Never retain a stale local block.
  const values = await Promise.all(aliases.map(to => redisGet(blacklist(from, webhookId, to))))
  return aliases.find((_to, index) => values[index] != null) || ''
}

export const addToBlacklistRedis: addToBlacklist = async (from: string, webhookId: string, to: string, ttl: number) => {
  const aliases = await resolveBlacklistAliases(from, [to])
  await setBlacklistAliases(from, webhookId, aliases, ttl)
  return true
}

export const addToBlacklistJob: addToBlacklist = async (from: string, webhookId: string, to: string, ttl: number) => {
  await amqpPublish(UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BLACKLIST_ADD, from, { from, webhookId, to, ttl }, { type: 'topic' })
  return true
}
