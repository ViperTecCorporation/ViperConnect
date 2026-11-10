import { ViperConnectApp } from '../../frontend/app'

const phone = '999123456789'
const setup = () => {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.render = jest.fn(); app.showToast = jest.fn(); app.modal = undefined
  app.sessionStorage = { modal: true, setConfirmed: jest.fn(), reset: jest.fn() }
  app.identity = { role: 'user' }; app.view = 'dashboard'; app.tab = 'overview'
  return app
}

test.each(['admin', 'user'])('session Redis shortcut is admin-only and prefilters the session (%s)', async role => {
  const app = setup(); app.identity.role = role; app.selectedPhone = phone; app.loadRedisKeys = jest.fn()
  const action = { dataset: { action: 'storage-redis-open', id: phone } }
  await app.handleClick({ target: { closest: (selector: string) => selector === '[data-action]' ? action : null, matches: () => false } })
  if (role === 'admin') { expect(app.redisSession).toBe(phone); expect(app.view).toBe('redis'); expect(app.loadRedisKeys).toHaveBeenCalledTimes(1) }
  else expect(app.loadRedisKeys).not.toHaveBeenCalled()
})

test('the one-second refresh timer does not replace an open storage confirmation', () => {
  const app = setup(); app.api = { getToken: () => 'test-token' }; app.refreshIn = 1; app.loadSessions = jest.fn()
  app.tickRefresh()
  expect(app.refreshIn).toBe(1); expect(app.loadSessions).not.toHaveBeenCalled(); expect(app.render).not.toHaveBeenCalled()
})

test('initial contact count is adopted without redrawing storage confirmation; ordinary overview rendering remains available', async () => {
  const app = setup(); app.selectedPhone = phone; app.contactCountRevision = 1
  app.api = { contacts: jest.fn().mockResolvedValue({ total_count: 42 }) }
  await app.loadOverviewContactCount(phone, 1)
  expect(app.overviewContactCount).toBe(42); expect(app.render).not.toHaveBeenCalled()
  app.sessionStorage.modal = false; await app.loadOverviewContactCount(phone, 1)
  expect(app.render).toHaveBeenCalledTimes(1)
})

test('version-status background response cannot reset storage confirmation', async () => {
  const app = setup(); app.api = { getToken: () => 'test-token', versionStatus: jest.fn().mockResolvedValue({ status: 'current' }) }
  await app.loadVersionStatus()
  expect(app.versionStatus).toEqual({ status: 'current' }); expect(app.render).not.toHaveBeenCalled()
  app.sessionStorage.modal = false; await app.loadVersionStatus()
  expect(app.render).toHaveBeenCalledTimes(1)
})

test('session-list refresh updates stored data but does not redraw at request start or completion while storage confirmation is open', async () => {
  const app = setup(); app.loading = false; app.selectedPhone = phone
  app.api = { getToken: () => 'test-token', sessions: jest.fn().mockResolvedValue([{ phone, provider: 'zapo', status: 'offline' }]) }
  app.mobileDevices = { load: jest.fn().mockResolvedValue(undefined) }
  await app.loadSessions()
  expect(app.findSession(phone).status).toBe('offline'); expect(app.loading).toBe(false); expect(app.render).not.toHaveBeenCalled()
})

test('late session detail is adopted without replacing a storage confirmation opened while loading', async () => {
  const app = setup(); app.sessionStorage.modal = false; app.sessions = [{ phone, provider: 'zapo' }]
  app.loadOverviewContactCount = jest.fn()
  let resolve!: (value: object) => void
  app.api = { session: jest.fn().mockReturnValue(new Promise(done => { resolve = done })) }
  const loading = app.openSession(phone)
  expect(app.render).toHaveBeenCalledTimes(1)
  app.sessionStorage.modal = true
  resolve({ business_account_id: '123456789' }); await loading
  expect(app.findSession(phone).business_account_id).toBe('123456789')
  expect(app.render).toHaveBeenCalledTimes(1)
})

test.each(['admin', 'user'])('only an administrator change event inside a storage confirmation updates checkbox UI state (%s)', role => {
  const app = setup(); app.identity.role = role
  const input = { checked: true, name: 'confirm', dataset: {},
    matches: (selector: string) => selector === 'input[type="checkbox"][name="confirm"]',
    closest: (selector: string) => selector === 'form[data-form^="storage-"]' ? {} : null }
  app.handleFilter({ type: 'change', target: input })
  if (role === 'admin') expect(app.sessionStorage.setConfirmed).toHaveBeenCalledWith(true)
  else expect(app.sessionStorage.setConfirmed).not.toHaveBeenCalled()
  expect(app.render).not.toHaveBeenCalled()
})

test.each(['input-event', 'unrelated-form'])('unrelated checkbox events do not alter storage confirmation (%s)', kind => {
  const app = setup(); app.identity.role = 'admin'
  const input = { checked: true, name: 'confirm', dataset: {}, matches: (selector: string) => selector === 'input[type="checkbox"][name="confirm"]',
    closest: () => null }
  app.handleFilter({ type: kind === 'input-event' ? 'input' : 'change', target: input })
  expect(app.sessionStorage.setConfirmed).not.toHaveBeenCalled()
})

test.each(['admin', 'user'])('opening SQLite storage from legacy backup dialogs never stacks modals (%s)', async role => {
  const app = setup(); app.identity.role = role
  app.mobileDevices = { modal: 'backup' }; app.sessionTransfers = { modal: 'backup' }
  app.sessionStorage.action = jest.fn().mockResolvedValue(undefined)
  const action = { dataset: { action: 'storage-open', id: phone } }
  await app.handleClick({ target: { closest: (selector: string) => selector === '[data-action]' ? action : null, matches: () => false } })
  if (role === 'admin') {
    expect(app.mobileDevices.modal).toBeUndefined(); expect(app.sessionTransfers.modal).toBeUndefined()
    expect(app.sessionStorage.action).toHaveBeenCalledWith('storage-open', phone)
  } else {
    expect(app.mobileDevices.modal).toBe('backup'); expect(app.sessionStorage.action).not.toHaveBeenCalled()
  }
})
