import { renderWebhookHistory } from '../../frontend/features/webhook_history'
import { ApiClient } from '../../frontend/core/api'
import { ViperConnectApp } from '../../frontend/app'
describe('webhook history UI', () => {
  test('loads only in the webhook tab and ignores an old session response', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    let resolve!: (value: object) => void
    app.selectedPhone = '5511999999'
    app.webhookHistoryRequest = 0
    app.webhookHistorySnapshots = []
    app.api = { webhookHistory: jest.fn().mockReturnValue(new Promise(done => { resolve = done })) }
    app.render = jest.fn()
    await app.openSessionTab('overview')
    expect(app.api.webhookHistory).not.toHaveBeenCalled()
    const pending = app.openSessionTab('webhooks')
    expect(app.api.webhookHistory).toHaveBeenCalledWith('5511999999')
    app.selectedPhone = '5511888888'
    resolve({ snapshots: [{ id: 'wrong-session' }] })
    await pending
    expect(app.webhookHistorySnapshots).toEqual([])
  })
  test('restoration sends explicit selection without registration or reconnect', async () => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.selectedPhone = '5511999999'
    app.api = { restoreWebhookHistory: jest.fn().mockResolvedValue({ enabled: false }), session: jest.fn().mockResolvedValue({ webhooks: [] }) }
    app.findSession = jest.fn().mockReturnValue({ phone: app.selectedPhone })
    app.replaceSession = jest.fn()
    app.showToast = jest.fn()
    app.loadWebhookHistory = jest.fn().mockResolvedValue(undefined)
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
    try {
      const data = new FormData()
      data.set('snapshot_id', 's'); data.append('webhook_ids', 'x')
      await app.restoreWebhookHistory(data)
      expect(app.api.restoreWebhookHistory).toHaveBeenCalledWith('5511999999', { snapshot_id: 's', webhook_ids: ['x'], replace_existing: false })
      expect(app.loadWebhookHistory).toHaveBeenCalled()
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
  test('escapes previews, selects IDs and requires explicit conflict authorization', () => {
    const html = renderWebhookHistory([{ id: 's', archived_at: 'now', reason: 'removed', server: 'server_1', webhooks: [{ id: '<x>', destination: '<script>', events: ['sendNewMessages'], has_credentials: true }] }], false, '')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('name="webhook_ids"')
    expect(html).toContain('name="replace_existing"')
    expect(html).not.toContain('checked')
    expect(html).toContain('desativados')
  })
  test('shows loading, empty and access failure states', () => {
    expect(renderWebhookHistory([], true, '')).toContain('Carregando')
    expect(renderWebhookHistory([], false, '')).toContain('Nenhum histórico')
    expect(renderWebhookHistory([], false, 'Acesso negado')).toContain('role="alert"')
  })
  test('uses admin history routes without registration or reconnection', async () => {
    const fetcher = jest.fn().mockImplementation(async () => new Response('{}', { status: 200 }))
    const api = new ApiClient('https://uno.example.com', fetcher)
    api.setToken('admin')
    await api.webhookHistory('5511999999')
    await api.restoreWebhookHistory('5511999999', { snapshot_id: 's', webhook_ids: ['x'] })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://uno.example.com/admin/webhooks/history/5511999999', 'https://uno.example.com/admin/webhooks/history/5511999999/restore'])
  })
})
