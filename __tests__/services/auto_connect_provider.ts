import { mockDeep } from 'jest-mock-extended'
import { autoConnect } from '../../src/services/auto_connect'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import type { SessionStore } from '../../src/services/session_store'

describe('autoConnect provider isolation', () => {
  test('connects only sessions assigned to the current worker engine', async () => {
    const sessionStore = mockDeep<SessionStore>()
    sessionStore.getPhones.mockResolvedValue(['baileys-phone', 'zapo-phone'])
    sessionStore.isStatusStandBy.mockResolvedValue(false)
    const getConfig = jest.fn(async (phone: string) => ({
      ...defaultConfig,
      server: process.env.UNOAPI_SERVER_NAME || 'server_1',
      provider: phone.startsWith('zapo') ? 'zapo' as const : 'baileys' as const,
    }))
    const getClient = jest.fn().mockResolvedValue({})

    await autoConnect(sessionStore, mockDeep<Listener>(), getConfig, getClient, jest.fn(), 'zapo')

    expect(getClient).toHaveBeenCalledTimes(1)
    expect(getClient).toHaveBeenCalledWith(expect.objectContaining({ phone: 'zapo-phone' }))
    expect(sessionStore.setStatus).toHaveBeenCalledWith('zapo-phone', 'offline')
    expect(sessionStore.setStatus).not.toHaveBeenCalledWith('baileys-phone', 'offline')
  })
})
