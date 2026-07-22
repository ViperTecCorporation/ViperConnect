jest.mock('../../src/services/client_baileys', () => ({ getClientBaileys: jest.fn() }))
jest.mock('../../src/services/client_zapo', () => ({
  ClientZapo: jest.fn().mockImplementation(() => ({ connect: jest.fn().mockResolvedValue(undefined) })),
}))

import { mockDeep } from 'jest-mock-extended'
import { clients } from '../../src/services/client'
import { getClientBaileys } from '../../src/services/client_baileys'
import { ClientZapo } from '../../src/services/client_zapo'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import { getClientProvider } from '../../src/services/providers/client_factory'

describe('provider client factory', () => {
  beforeEach(() => {
    clients.clear()
    jest.clearAllMocks()
  })

  test('keeps Baileys as the default engine', async () => {
    const baileys = { connect: jest.fn() } as never
    ;(getClientBaileys as jest.Mock).mockResolvedValue(baileys)
    const args = {
      phone: '5566',
      listener: mockDeep<Listener>(),
      getConfig: async () => ({ ...defaultConfig, provider: undefined }),
      onNewLogin: jest.fn(),
    }

    await expect(getClientProvider(args)).resolves.toBe(baileys)
    expect(getClientBaileys).toHaveBeenCalledWith(args)
  })

  test('creates and caches a Zapo client for a Zapo session', async () => {
    const args = {
      phone: '5577',
      listener: mockDeep<Listener>(),
      getConfig: async () => ({ ...defaultConfig, provider: 'zapo' as const, autoConnect: true }),
      onNewLogin: jest.fn(),
    }

    const first = await getClientProvider(args)
    const second = await getClientProvider(args)

    expect(first).toBe(second)
    expect(ClientZapo).toHaveBeenCalledTimes(1)
    expect(first.connect).toHaveBeenCalledWith(1)
  })
})
