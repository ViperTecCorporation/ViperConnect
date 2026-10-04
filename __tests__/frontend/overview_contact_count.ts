import { ViperConnectApp } from '../../frontend/app'

function fixture() {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.selectedPhone = '999123456789'; app.contactCountRevision = 1
  app.view = 'dashboard'; app.tab = 'overview'; app.render = jest.fn()
  app.api = { contacts: jest.fn().mockResolvedValue({ total_count: 42 }) }
  return app
}
test('loads total with a single cache page without opening Contacts', async () => {
  const app = fixture()
  await app.loadOverviewContactCount(app.selectedPhone, 1)
  expect(app.api.contacts).toHaveBeenCalledWith('999123456789', '0', 1, '')
  expect(app.overviewContactCount).toBe(42)
  expect(app.render).toHaveBeenCalledTimes(1)
})

test('opening a session starts the independent count immediately', async () => {
  const app = fixture()
  app.sessions = [{ phone: app.selectedPhone, provider: 'zapo', status: 'online' }]
  app.api.session = jest.fn().mockResolvedValue({})
  app.showToast = jest.fn()
  await app.openSession(app.selectedPhone)
  expect(app.api.contacts).toHaveBeenCalledWith('999123456789', '0', 1, '')
  expect(app.overviewContactCount).toBe(42)
  expect(app.tab).toBe('overview')
})
test.each(['session', 'revision'])('ignores stale response after %s changed', async kind => {
  const app = fixture()
  const pending = app.loadOverviewContactCount(app.selectedPhone, 1)
  if (kind === 'session') app.selectedPhone = '999111111111'
  else app.contactCountRevision++
  await pending
  expect(app.overviewContactCount).toBeUndefined(); expect(app.render).not.toHaveBeenCalled()
})
test('failure stays unknown, and a modal is never interrupted', async () => {
  const app = fixture(); app.api.contacts.mockRejectedValueOnce(new Error('offline'))
  await app.loadOverviewContactCount(app.selectedPhone, 1)
  expect(app.overviewContactCount).toBeUndefined()
  app.modal = {}; await app.loadOverviewContactCount(app.selectedPhone, 1)
  expect(app.overviewContactCount).toBe(42); expect(app.render).not.toHaveBeenCalled()
})
