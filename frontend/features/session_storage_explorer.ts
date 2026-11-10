import { ApiClient } from '../core/api.js'
import { escapeHtml as e } from '../core/html.js'
import { renderModal } from '../components/modal.js'

type Cell = { value: unknown; editable: boolean; input?: string; format?: string; bytes?: number }
type Row = { id: string; key: string; etag?: string; cells: Record<string, Cell> }
type Page = { generation: number; table?: string; tables: Array<{ name: string; editable: boolean; protected: boolean }>; columns?: Array<{ name: string; type: string; required: boolean }>; rows: Row[]; nextCursor?: string | null; hasMore?: boolean; scanned?: number }
const json = (value: unknown) => JSON.stringify(value, null, 2)

/** Session-local inspector. GETs page data; explicit confirmed POSTs are never retried. */
export class SessionStorageExplorer {
  open = false; busy = false; error = ''; notice = ''; phone = ''; table = ''; search = ''; canWrite = false
  page?: Page
  editor?: { action: 'create' | 'update' | 'delete'; row?: Row; text: string }
  private cursor = ''; private previous: string[] = []; private revision = 0
  constructor(private readonly api: ApiClient, private readonly render: () => void) {}
  reset() { this.revision++; this.open = false; this.busy = false; this.page = undefined; this.editor = undefined; this.phone = ''; this.table = ''; this.search = ''; this.cursor = ''; this.previous = []; this.error = ''; this.notice = '' }
  private path() { return `/v15.0/${encodeURIComponent(this.phone)}/storage/explorer` }
  async show(phone: string, canWrite: boolean) {
    this.reset(); this.open = true; this.phone = phone; this.canWrite = canWrite
    await this.load()
  }
  private async load() {
    const revision = ++this.revision; this.busy = true; this.error = ''; this.render()
    try {
      const query = new URLSearchParams({ limit: '25' })
      if (this.table) query.set('table', this.table)
      if (this.search) query.set('search', this.search)
      if (this.cursor) query.set('cursor', this.cursor)
      const page = await this.api.request<Page>(`${this.path()}?${query}`)
      if (revision === this.revision) this.page = page
    } catch (error) { if (revision === this.revision) this.error = error instanceof Error ? error.message : 'Falha ao consultar banco.' }
    finally { if (revision === this.revision) { this.busy = false; this.render() } }
  }
  async action(action: string, id: string) {
    if (action === 'storage-explorer-close') { this.reset(); this.render(); return }
    if (this.busy) return
    if (action === 'storage-explorer-refresh') { this.editor = undefined; await this.load(); return }
    if (action === 'storage-explorer-next' && this.page?.nextCursor) { this.previous.push(this.cursor); this.cursor = this.page.nextCursor; await this.load(); return }
    if (action === 'storage-explorer-previous' && this.previous.length) { this.cursor = this.previous.pop()!; await this.load(); return }
    if (action === 'storage-explorer-cancel') { this.editor = undefined; this.render(); return }
    if (!this.canWrite || !this.table) return
    const row = this.page?.rows.find(row => row.id === id)
    if (action === 'storage-explorer-create') {
      const values = Object.fromEntries((this.page?.columns || []).filter(c => c.required && c.name !== 'session_id').map(c => [c.name, c.type.includes('INT') ? 0 : c.type.includes('BLOB') ? { utf8: '' } : '']))
      this.editor = { action: 'create', text: json(values) }
    } else if (row?.etag && ['storage-explorer-update', 'storage-explorer-delete'].includes(action)) {
      const values = Object.fromEntries(Object.entries(row.cells).filter(([key, cell]) => cell.editable && key !== 'session_id').map(([key, cell]) => [key,
        cell.format === 'utf8-blob' ? { utf8: cell.input } : cell.format === 'number' ? Number(cell.value) : cell.value === null ? null : cell.input ?? cell.value]))
      this.editor = { action: action.endsWith('delete') ? 'delete' : 'update', row, text: json(values) }
    }
    this.error = ''; this.render()
  }
  async submit(form: string, data: FormData) {
    if (this.busy) return
    if (form === 'storage-explorer-search') {
      this.table = String(data.get('table') || ''); this.search = String(data.get('search') || '').trim(); this.cursor = ''; this.previous = []; this.editor = undefined; this.notice = ''
      await this.load(); return
    }
    if (form !== 'storage-explorer-save' || !this.editor || !this.canWrite || !this.page) return
    this.editor.text = String(data.get('values') || this.editor.text)
    if (data.get('confirm') !== 'on') { this.error = 'Confirme a alteração antes de continuar.'; this.render(); return }
    const revision = this.revision, edit = this.editor
    let values: unknown
    try { if (edit.action !== 'delete') values = JSON.parse(this.editor.text) }
    catch { this.error = 'Informe um objeto JSON válido.'; this.render(); return }
    this.busy = true; this.error = ''; this.render()
    try {
      const result = await this.api.request<{ backupId: string }>(this.path(), { method: 'POST', body: JSON.stringify({ action: edit.action, table: this.table, generation: this.page.generation, confirm: true,
        ...(edit.row ? { rowId: edit.row.id, etag: edit.row.etag } : {}), ...(edit.action !== 'delete' ? { values } : {}) }) })
      if (revision !== this.revision) return
      this.editor = undefined; this.notice = `Alteração concluída. Backup anterior: ${result.backupId}.`; this.cursor = ''; this.previous = []; await this.load()
    } catch (error) { if (revision === this.revision) this.error = `${error instanceof Error ? error.message : 'Falha na alteração'}. Não houve repetição automática; consulte os dados antes de tentar novamente.` }
    finally { if (revision === this.revision) { this.busy = false; this.render() } }
  }
  html() {
    if (!this.open) return ''
    const disabled = this.busy ? ' disabled' : '', page = this.page
    const editor = this.editor ? `<form data-form="storage-explorer-save" class="storage-explorer__editor"><h3>${this.editor.action === 'create' ? 'Criar registro' : this.editor.action === 'delete' ? 'Excluir registro' : 'Editar registro'}</h3>
      ${this.editor.row ? `<p class="storage-explorer__key">${e(this.editor.row.key)}</p>` : ''}
      ${this.editor.action === 'delete' ? '<p>A exclusão será persistida no SQLite. Não remove mensagens do aparelho WhatsApp.</p>' : `<label>Valores / campos a alterar (JSON)<textarea name="values" rows="12" required spellcheck="false"${disabled}>${e(this.editor.text)}</textarea></label><p class="muted">Texto em BLOB: {"utf8":"valor"}. Binário: {"base64":"..."}. Campos omitidos são preservados na edição.</p>`}
      <label class="storage-confirm"><input name="confirm" type="checkbox" required${disabled}>Confirmo alterar os dados persistidos desta sessão. Será exigido backup S3 verificado.</label>
      <div class="storage-actions"><button class="btn"${disabled}>${this.busy ? 'Verificando backup e salvando…' : 'Confirmar alteração'}</button><button type="button" class="btn btn--ghost" data-action="storage-explorer-cancel"${disabled}>Cancelar</button></div></form>` : ''
    const body = `<div class="storage-explorer"><p class="storage-caption">SQLite desta sessão · consultas locais, sem acesso ao WhatsApp. Tabelas internas e segredos são protegidos.</p>
      <form data-form="storage-explorer-search" class="storage-explorer__filters"><label>Tabela<select name="table" required${disabled}><option value="">Selecione uma tabela</option>${(page?.tables || []).map(t => `<option value="${e(t.name)}"${t.name === this.table ? ' selected' : ''}${!t.editable ? ' disabled' : ''}>${e(t.name)}${!t.editable ? ' · protegida' : ''}</option>`).join('')}</select></label><label>Chave / identificador<input name="search" maxlength="120" value="${e(this.search)}"${disabled}></label><button class="btn"${disabled}>Consultar</button></form>
      <p class="storage-caption">${this.canWrite ? 'CRUD habilitado: sessão offline. Cada alteração exige confirmação e backup S3.' : 'Para criar, editar ou excluir: desconecte a sessão e desative a reconexão automática.'}</p>
      ${this.error ? `<p role="alert" class="storage-warning">${e(this.error)}</p>` : ''}${this.notice ? `<p role="status" class="storage-caption">${e(this.notice)}</p>` : ''}
      ${this.table && !this.editor ? `<div class="storage-actions"><button type="button" class="btn" data-action="storage-explorer-create"${!this.canWrite || this.busy ? ' disabled' : ''}>Criar registro</button><button type="button" class="btn btn--ghost" data-action="storage-explorer-refresh"${disabled}>Atualizar</button></div>` : ''}
      ${editor || `<div class="storage-explorer__rows">${(page?.rows || []).map(row => `<details class="storage-explorer__row"><summary><code>${e(row.key)}</code><small>Registro ${e(row.id)}</small></summary><pre>${e(json(Object.fromEntries(Object.entries(row.cells).map(([key, cell]) => [key, cell.value]))))}</pre><div class="storage-actions"><button type="button" class="btn btn--ghost btn--small" data-action="storage-explorer-update" data-id="${e(row.id)}"${!this.canWrite || !row.etag || this.busy ? ' disabled' : ''}>Editar</button><button type="button" class="btn btn--danger btn--small" data-action="storage-explorer-delete" data-id="${e(row.id)}"${!this.canWrite || !row.etag || this.busy ? ' disabled' : ''}>Excluir</button></div></details>`).join('') || `<p class="muted">${this.busy ? 'Consultando…' : page?.table ? 'Nenhum resultado neste trecho.' : 'Selecione uma tabela para explorar.'}</p>`}</div>`}
      ${!this.editor && this.table ? `<div class="storage-actions"><button type="button" class="btn btn--ghost" data-action="storage-explorer-previous"${!this.previous.length || this.busy ? ' disabled' : ''}>Anterior</button><button type="button" class="btn btn--ghost" data-action="storage-explorer-next"${!page?.hasMore || this.busy ? ' disabled' : ''}>${this.search ? 'Continuar busca' : 'Próxima página'}</button><small class="muted">${page?.rows.length || 0} registros exibidos · ${page?.scanned || 0} examinados</small></div>` : ''}</div>`
    return renderModal('session-storage-explorer', 'Explorar SQLite', body, { subtitle: this.phone, wide: true }).replace('data-close-modal', 'data-action="storage-explorer-close"')
  }
}
