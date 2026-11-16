jest.mock('../../src/services/client_zapo', () => ({ ClientZapo: jest.fn().mockImplementation(() => ({ connect: jest.fn(), disconnect: jest.fn() })) }))
import { clients } from '../../src/services/client'
import { ClientZapo } from '../../src/services/client_zapo'
import { defaultConfig } from '../../src/services/config'
import { getClientProvider } from '../../src/services/providers/client_factory'

beforeEach(() => { clients.clear(); jest.clearAllMocks() })
afterEach(() => clients.clear())
const phone = '5566000000193'
const args = (config: any) => ({ phone, listener: {} as any, getConfig: async () => config, onNewLogin: jest.fn() })

test('suspended QR never creates the placeholder that blocks restore', async () => {
  await expect(getClientProvider(args({ ...defaultConfig, provider: 'zapo', autoConnect: false }))).rejects.toThrow('session_suspended')
  expect(ClientZapo).not.toHaveBeenCalled(); expect(clients.has(phone)).toBe(false)
})

test.each(['migrating', 'restoring', 'fixture'])('even an existing client cannot bypass a fresh %s fence', async state => {
  clients.set(phone, {} as any)
  const config = { ...defaultConfig, provider: 'zapo', sessionStorage: { backend: 'redis', state: state === 'fixture' ? 'offline' : state, fixture: state === 'fixture' } }
  await expect(getClientProvider(args(config))).rejects.toThrow(state === 'fixture' ? 'external_effects_forbidden' : 'operation_in_progress')
})

test.each([false, true])('new QR and primary clients connect only after confirmed active config (primary=%s)', async primary => {
  const client = await getClientProvider(args({ ...defaultConfig, provider: 'zapo', ...(primary ? { mobilePrimaryDraftId: 'synthetic', mobilePrimaryImported: true } : {}) }))
  expect(client.connect).toHaveBeenCalledWith(1); expect(clients.get(phone)).toBe(client)
})
