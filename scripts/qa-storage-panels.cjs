// Playwright CLI run-code fixture. Actual compiled components/CSS; no authenticated API calls.
async (page) => {
  await page.route('**/storage-panel-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app/styles.css"></head><body><main id="qa"></main></body></html>' }))
  await page.goto('http://localhost:9876/storage-panel-qa')
  await page.evaluate(async () => {
    const { SessionStorageExplorer } = await import('/app/features/session_storage_explorer.js')
    const { VoipBackupPanel } = await import('/app/features/voip_backups.js')
    const root = document.getElementById('qa'), calls = [], id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let value = 'Conteúdo sintético persistido <observação>', rows = true, view
    const api = { request: async (url, init) => {
      calls.push({ url, method: init?.method || 'GET' })
      if (url.startsWith('/manager/voip-backups')) return init?.method === 'POST' ? { status: 'ready', uploadVerified: true, restored: true, beforeBackupId: id } : {
        enabled: true, automatic: true, bucket: 'bucket-sintetico', prefix: 'backups/voip/laboratorio/', state: { phase: 'ready' },
        files: [{ id, day: 2, createdAt: '2026-11-10T12:00:00Z', bytes: 262144 }] }
      if (init?.method === 'POST') { const body = JSON.parse(init.body); if (body.action === 'delete') rows = false; else { rows = true; value = body.values.value?.utf8 || value }; return { changed: true, backupId: id } }
      const table = new URL(url, location.origin).searchParams.get('table')
      return { generation: 1, tables: [{ name: 'uno_kv', editable: true }, { name: 'mailbox_messages', editable: true }, { name: 'auth_credentials', editable: false }], table,
        columns: [{ name: 'key', type: 'TEXT', required: true }, { name: 'value', type: 'BLOB', required: true }],
        rows: table && rows ? [{ id: '1', key: 'unoapi-contact-name:999123456789:contato', etag: 'a'.repeat(64), cells: { key: { value: 'unoapi-contact-name:999123456789:contato', input: 'unoapi-contact-name:999123456789:contato', editable: true, format: 'text' }, value: { value, input: value, editable: true, format: 'utf8-blob' } } }] : [], scanned: table ? 1 : 0, hasMore: false }
    } }
    const paint = () => { root.innerHTML = view.html ? view.html() : view.dialog() }
    root.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) void view.action(button.dataset.action, button.dataset.id || '') })
    root.addEventListener('submit', event => { event.preventDefault(); const form = event.target; const data = new FormData(form); void (view.html ? view.submit(form.dataset.form, data) : view.submit(data)) })
    window.__storageQa = { calls, showVoip: async () => { view.reset(); view = new VoipBackupPanel(api, paint); await view.action('voip-backup-open') } }
    view = new SessionStorageExplorer(api, paint); await view.show('999123456789', true)
  })
  return { synthetic: true, realApiCalls: 0 }
}
