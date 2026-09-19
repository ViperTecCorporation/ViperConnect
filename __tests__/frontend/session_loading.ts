import { ViperConnectApp } from '../../frontend/app'
import { renderSessionPage } from '../../frontend/pages/session'

const setup = () => {
  const app = Object.create(ViperConnectApp.prototype) as any
  let resolve!: (value: object) => void
  let reject!: (error: Error) => void
  app.sessions = [{ phone: '5511999999999', provider: 'zapo', status: 'online' }]
  app.api = { session: jest.fn().mockReturnValue(new Promise((ok, fail) => { resolve = ok; reject = fail })) }
  app.showToast = jest.fn()
  app.messageFor = (error: Error) => error.message
  app.render = jest.fn(() => {
    app.html = renderSessionPage({ session: app.findSession(app.selectedPhone), tab: app.tab,
      contacts: [], contactsHasMore: false, contactCount: 0, contactsQuery: '', groups: [],
      groupsHasMore: false, groupsQuery: '', loadingSection: false, sectionError: '' })
  })
  return { app, resolve, reject }
}

describe('initial session overview loading', () => {
  test('renders integration identifiers as soon as detail arrives, without switching tabs', async () => {
    const { app, resolve } = setup()
    const opening = app.openSession('5511999999999')
    expect(app.html).not.toContain('Integração WhatsApp')
    resolve({ business_account_id: '123456789', phone_number_id: '987654321' })
    await opening
    expect(app.render).toHaveBeenCalledTimes(2)
    expect(app.html).toContain('Integração WhatsApp')
    expect(app.html).toContain('123456789')
    expect(app.html).toContain('987654321')
    expect(app.tab).toBe('overview')
  })

  test.each(['tab', 'session', 'view', 'modal'])('does not interrupt a changed %s while detail is pending', async changed => {
    const { app, resolve } = setup()
    const opening = app.openSession('5511999999999')
    if (changed === 'tab') app.tab = 'config'
    if (changed === 'session') app.selectedPhone = '5511888888888'
    if (changed === 'view') app.view = 'queues'
    if (changed === 'modal') app.modal = { type: 'test-message' }
    resolve({ business_account_id: '123456789' })
    await opening
    expect(app.render).toHaveBeenCalledTimes(1)
    expect(app.findSession('5511999999999').business_account_id).toBe('123456789')
  })

  test('keeps the overview usable and reports a detail failure', async () => {
    const { app, reject } = setup()
    const opening = app.openSession('5511999999999')
    reject(new Error('detail unavailable'))
    await opening
    expect(app.showToast).toHaveBeenCalledWith('detail unavailable')
    expect(app.render).toHaveBeenCalledTimes(1)
    expect(app.tab).toBe('overview')
  })
})
