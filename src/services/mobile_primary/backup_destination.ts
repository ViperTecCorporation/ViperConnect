import { isMobileBackupKey } from './backup_manifest'

interface DestinationRedis {
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', size: number): Promise<[string, string[]]>
}

/** Existence check only: stop at the first exact session key, regardless of count. */
export async function mobileBackupDestinationHasKeys(redis: DestinationRedis, prefix: string, phone: string, renew: () => Promise<void>): Promise<boolean> {
  for (const base of [prefix, 'unoapi-']) {
    let cursor = '0', renewed = 0
    do {
      if (Date.now() - renewed >= 10000) { await renew(); renewed = Date.now() }
      const page = await redis.scan(cursor, 'MATCH', base + '*' + phone + '*', 'COUNT', 200)
      cursor = page[0]
      if (page[1].some(key => key.startsWith(base) && isMobileBackupKey(key.slice(base.length), phone, 'complete', base === 'unoapi-' ? 'uno' : undefined))) return true
    } while (cursor !== '0')
  }
  return false
}
