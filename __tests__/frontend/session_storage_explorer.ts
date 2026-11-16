import { SessionStorageExplorer } from '../../frontend/features/session_storage_explorer'
const phone = '999123456789'
const cell = { value: '<script>unsafe</script>', input: '<script>unsafe</script>', editable: true, format: 'utf8-blob' }
const page = { generation: 2, table: 'uno_kv', tables: [{ name: 'uno_kv', editable: true }, { name: 'auth_credentials', editable: false }], columns: [{ name: 'key', type: 'TEXT', required: true }, { name: 'value', type: 'BLOB', required: true }], rows: [{ id: '1', key: `unoapi-contact-name:${phone}:x`, etag: 'a'.repeat(64), cells: { value: cell } }], hasMore: true, nextCursor: 'opaque' }
const search = () => { const d = new FormData(); d.set('table', 'uno_kv'); d.set('search', 'x'); return d }

test('inspector escapes stored HTML, protects system tables and disables live-session mutations', async () => {
  const api: any = { request: jest.fn().mockResolvedValue(page) }, view = new SessionStorageExplorer(api, jest.fn())
  await view.show(phone, false)
  expect(view.html()).not.toContain('<script>unsafe</script>'); expect(view.html()).toContain('&lt;script&gt;')
  await view.submit('storage-explorer-search', search())
  expect(api.request.mock.calls[1][0]).toContain('table=uno_kv&search=x')
  expect(view.html()).toContain('data-action="storage-explorer-create" disabled')
  await view.action('storage-explorer-update', '1'); expect(view.editor).toBeUndefined()
  expect(api.request.mock.calls.every(([, init]: any) => !init?.method)).toBe(true)
})

test('CRUD requires confirmation, sends a single scoped CAS POST and preserves hidden values', async () => {
  const api: any = { request: jest.fn().mockResolvedValue(page) }, view = new SessionStorageExplorer(api, jest.fn())
  await view.show(phone, true); await view.submit('storage-explorer-search', search()); await view.action('storage-explorer-update', '1')
  const d = new FormData(); d.set('values', '{"value":{"utf8":"edited"}}')
  await view.submit('storage-explorer-save', d)
  expect(api.request.mock.calls.filter(([, init]: any) => init?.method === 'POST')).toHaveLength(0)
  d.set('confirm', 'on'); api.request.mockResolvedValueOnce({ backupId: 'backup' }).mockResolvedValueOnce(page)
  await view.submit('storage-explorer-save', d)
  const posts = api.request.mock.calls.filter(([, init]: any) => init?.method === 'POST')
  expect(posts).toHaveLength(1); expect(JSON.parse(posts[0][1].body)).toEqual({ action: 'update', table: 'uno_kv', generation: 2, confirm: true, rowId: '1', etag: 'a'.repeat(64), values: { value: { utf8: 'edited' } } })
  expect(view.notice).toContain('backup'); expect(view.busy).toBe(false)
})

test('ambiguous mutation failure is not retried and closing/switching sessions discards stale results', async () => {
  const api: any = { request: jest.fn().mockResolvedValue(page) }, view = new SessionStorageExplorer(api, jest.fn())
  await view.show(phone, true); await view.submit('storage-explorer-search', search()); await view.action('storage-explorer-delete', '1')
  const d = new FormData(); d.set('confirm', 'on'); api.request.mockRejectedValueOnce(new Error('network timeout'))
  await view.submit('storage-explorer-save', d)
  expect(view.error).toContain('Não houve repetição'); expect(api.request.mock.calls.filter(([, init]: any) => init?.method === 'POST')).toHaveLength(1)
  let resolve!: (value: any) => void
  api.request.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const loading = view.show(phone, false); view.reset(); resolve(page); await loading
  expect(view.page).toBeUndefined(); expect(view.open).toBe(false)
})
