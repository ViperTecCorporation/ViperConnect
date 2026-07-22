import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BufferJSON } from '@whiskeysockets/baileys'
import type { BaileysAuthSnapshot } from 'wa-store-migrate/baileys'
import { authKey, getAuthIndexMembers, redisMGet, redisScanSome } from '../redis'

const BAILEYS_KEY_TYPES = [
  'app-state-sync-version',
  'app-state-sync-key',
  'sender-key-memory',
  'identity-key',
  'device-list',
  'lid-mapping',
  'sender-key',
  'pre-key',
  'session',
  'tctoken',
] as const

type ParsedAuthKey = { type: 'creds' } | { type: string; id: string }

export const parseBaileysAuthStorageKey = (phone: string, storageKey: string): ParsedAuthKey | undefined => {
  const fileName = basename(storageKey)
  if (fileName === 'creds.json') return { type: 'creds' }

  const redisPrefix = `${authKey(phone)}:`
  const logicalKey = storageKey.startsWith(redisPrefix)
    ? storageKey.slice(redisPrefix.length)
    : fileName.replace(/\.json$/i, '')
  if (logicalKey === 'creds') return { type: 'creds' }

  const category = BAILEYS_KEY_TYPES.find((type) => logicalKey.startsWith(`${type}-`))
  if (!category) return undefined
  const id = logicalKey.slice(category.length + 1).replace(/__/g, '/')
  return id ? { type: category, id } : undefined
}

const buildSnapshot = (phone: string, entries: ReadonlyArray<{ key: string; raw: string }>): BaileysAuthSnapshot | undefined => {
  let creds: BaileysAuthSnapshot['creds'] | undefined
  const keys: Record<string, Record<string, unknown>> = {}
  for (const entry of entries) {
    const parsedKey = parseBaileysAuthStorageKey(phone, entry.key)
    if (!parsedKey) continue
    const value = JSON.parse(entry.raw, BufferJSON.reviver)
    if (parsedKey.type === 'creds') {
      creds = value
      continue
    }
    const signalKey = parsedKey as { type: string; id: string }
    ;(keys[signalKey.type] ??= {})[signalKey.id] = value
  }
  return creds ? { creds, keys: keys as BaileysAuthSnapshot['keys'] } : undefined
}

export const readBaileysFileSnapshot = (phone: string, baseStore: string): BaileysAuthSnapshot | undefined => {
  const directory = join(baseStore, 'sessions', phone)
  const credentialsFile = join(directory, 'creds.json')
  if (!existsSync(credentialsFile)) return undefined
  const entries = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ key: file, raw: readFileSync(join(directory, file), 'utf8') }))
  return buildSnapshot(phone, entries)
}

export const readBaileysRedisSnapshot = async (phone: string): Promise<BaileysAuthSnapshot | undefined> => {
  let storageKeys = await getAuthIndexMembers(phone)
  if (!storageKeys.length) storageKeys = await redisScanSome(`${authKey(phone)}:*`, 100_000)
  if (!storageKeys.length) return undefined
  const values = await redisMGet(storageKeys)
  const entries = storageKeys.flatMap((key, index) => values[index] ? [{ key, raw: values[index]! }] : [])
  return buildSnapshot(phone, entries)
}
