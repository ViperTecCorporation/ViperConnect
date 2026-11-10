jest.mock('../../src/services/redis', () => ({ getConfig: jest.fn(), setConfig: jest.fn() }))
import { onNewLoginGenerateToken } from '../../src/services/on_new_login_generate_token'
import { getConfig, setConfig } from '../../src/services/redis'
import { assertSafeSessionConfigPatch } from '../../src/services/session_storage/config_patch'

const phone = '9990100000785'
let config: any, outgoing: any
beforeEach(() => {
  jest.resetAllMocks()
  config = { provider: 'zapo', server: 'worker_1', autoConnect: true,
    sessionStorage: { backend: 'sqlite', storageId: '12345678-1234-4234-8234-123456789abc', owner: 'worker_1', generation: 1, state: 'offline' } }
  outgoing = { formatAndSend: jest.fn(async () => ({ accepted: true })) }
  jest.mocked(getConfig).mockImplementation(async () => config)
  jest.mocked(setConfig).mockImplementation(async (_phone, patch) => { config = { ...config, ...patch }; return config })
})

test('new-login token is a narrow required-existing patch and preserves SQLite selection', async () => {
  const before = config
  await onNewLoginGenerateToken(outgoing)(phone)
  expect(setConfig).toHaveBeenCalledWith(phone, { authToken: expect.any(String) }, { expectedExisting: true, expectedConfig: before })
  expect(config.sessionStorage).toEqual(before.sessionStorage)
  expect(Object.keys(jest.mocked(setConfig).mock.calls[0][1])).toEqual(['authToken'])
  expect(outgoing.formatAndSend).toHaveBeenCalledTimes(1)
})

test('an existing token is reused without writing a stale full config', async () => {
  config.authToken = 'synthetic-token'
  await onNewLoginGenerateToken(outgoing)(phone)
  expect(setConfig).toHaveBeenCalledWith(phone, { authToken: 'synthetic-token' }, expect.any(Object))
  expect(outgoing.formatAndSend).toHaveBeenCalledWith(phone, phone, expect.objectContaining({ type: 'text', text: { body: expect.stringContaining('synthetic-token') } }))
})

test('a lost configuration never creates defaults or publishes the token webhook', async () => {
  config = undefined
  await expect(onNewLoginGenerateToken(outgoing)(phone)).rejects.toThrow('registration_required')
  expect(setConfig).not.toHaveBeenCalled(); expect(outgoing.formatAndSend).not.toHaveBeenCalled()
})

test('a generation change and suspension before config commit reject the callback without a token webhook', async () => {
  jest.mocked(setConfig).mockImplementationOnce(async (_phone, patch, options) => {
    config = { ...config, autoConnect: false, sessionStorage: { ...config.sessionStorage, generation: 2 } }
    assertSafeSessionConfigPatch(config, patch, { config: options!.expectedConfig, strict: true })
    return config
  })
  await expect(onNewLoginGenerateToken(outgoing)(phone)).rejects.toThrow('configuration_changed')
  expect(config).toMatchObject({ autoConnect: false, sessionStorage: { generation: 2 } })
  expect(config.authToken).toBeUndefined(); expect(outgoing.formatAndSend).not.toHaveBeenCalled()
})

test.each(['deleted', 'suspended', 'migrating'])('a %s session after token commit cannot publish a misleading new-login notification', async state => {
  const read = config
  jest.mocked(getConfig).mockResolvedValueOnce(read).mockImplementationOnce(async () => state === 'deleted' ? undefined
    : { ...config, ...(state === 'suspended' ? { autoConnect: false } : { sessionStorage: { ...config.sessionStorage, state: 'migrating' } }) })
  await expect(onNewLoginGenerateToken(outgoing)(phone)).rejects.toThrow(/registration_required|configuration_changed|operation_in_progress/)
  expect(outgoing.formatAndSend).not.toHaveBeenCalled()
})

test.each(['fixture', 'migrating', 'restoring', 'pending', 'primary_unimported', 'suspended'])('a %s session rejects new-login mutation before any config write', async state => {
  if (state === 'fixture') config.sessionStorage.fixture = true
  if (state === 'migrating' || state === 'restoring') config.sessionStorage.state = state
  if (state === 'pending') config.sessionStorageProvisionPending = { id: 'pending', autoConnect: true }
  if (state === 'primary_unimported') config.mobilePrimaryDraftId = 'draft'
  if (state === 'suspended') config.autoConnect = false
  await expect(onNewLoginGenerateToken(outgoing)(phone)).rejects.toThrow(/external_effects_forbidden|operation_in_progress|provision_unconfirmed|mobile_auth_import_required|session_suspended/)
  expect(setConfig).not.toHaveBeenCalled(); expect(outgoing.formatAndSend).not.toHaveBeenCalled()
})
