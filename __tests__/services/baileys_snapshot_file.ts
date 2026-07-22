jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}))

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { parseBaileysAuthStorageKey, readBaileysFileSnapshot } from '../../src/services/zapo/baileys_snapshot'

describe('Baileys file snapshot', () => {
  beforeEach(() => jest.clearAllMocks())

  test('parses credentials and key categories without confusing category hyphens', () => {
    expect(parseBaileysAuthStorageKey('5566', 'app-state-sync-key-my-key.json')).toEqual({
      type: 'app-state-sync-key',
      id: 'my-key',
    })
  })

  test('returns no snapshot when the Baileys credentials do not exist', () => {
    jest.mocked(existsSync).mockReturnValue(false)

    expect(readBaileysFileSnapshot('5566', '/store')).toBeUndefined()
    expect(readFileSync).not.toHaveBeenCalled()
  })

  test('reads a Baileys multi-file session into the migration shape', () => {
    jest.mocked(existsSync).mockReturnValue(true)
    jest.mocked(readdirSync).mockReturnValue(['creds.json', 'pre-key-7.json'] as never)
    jest
      .mocked(readFileSync)
      .mockImplementation((file) =>
        `${file}`.endsWith('creds.json')
          ? JSON.stringify({ registered: true, registrationId: 10 })
          : JSON.stringify({ public: 'public-key', private: 'private-key' }),
      )

    const snapshot = readBaileysFileSnapshot('5566', '/store')

    expect(snapshot?.creds).toEqual(expect.objectContaining({ registered: true, registrationId: 10 }))
    expect(snapshot?.keys['pre-key']?.['7']).toEqual({ public: 'public-key', private: 'private-key' })
    expect(readFileSync).toHaveBeenCalledWith('/store/sessions/5566/creds.json', 'utf8')
  })
})
