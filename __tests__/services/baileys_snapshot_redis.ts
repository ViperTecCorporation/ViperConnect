jest.mock('../../src/services/redis', () => ({
  authKey: (phone: string) => `unoapi-auth:${phone}`,
  getAuthIndexMembers: jest.fn(),
  redisMGet: jest.fn(),
  redisScanSome: jest.fn(),
}))

import { BufferJSON } from '@whiskeysockets/baileys'
import { getAuthIndexMembers, redisMGet, redisScanSome } from '../../src/services/redis'
import { readBaileysRedisSnapshot } from '../../src/services/zapo/baileys_snapshot'

describe('Baileys Redis snapshot', () => {
  test('reads indexed credentials and signal keys from Redis', async () => {
    const keys = ['unoapi-auth:5566:creds', 'unoapi-auth:5566:session-user:0']
    ;(getAuthIndexMembers as jest.Mock).mockResolvedValue(keys)
    ;(redisMGet as jest.Mock).mockResolvedValue([
      JSON.stringify({ registered: true }),
      JSON.stringify({ version: 'v1', state: 'serialized' }, BufferJSON.replacer),
    ])

    const snapshot = await readBaileysRedisSnapshot('5566')

    expect(snapshot?.creds.registered).toBe(true)
    expect(snapshot?.keys.session?.['user:0']).toEqual({ version: 'v1', state: 'serialized' })
  })

  test('falls back to a bounded scan for sessions created before the auth index', async () => {
    ;(getAuthIndexMembers as jest.Mock).mockResolvedValue([])
    ;(redisScanSome as jest.Mock).mockResolvedValue([])

    await expect(readBaileysRedisSnapshot('5566')).resolves.toBeUndefined()
    expect(redisScanSome).toHaveBeenCalledWith('unoapi-auth:5566:*', 100_000)
  })
})
