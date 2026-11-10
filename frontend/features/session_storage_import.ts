import { ApiClient, ApiError } from '../core/api.js'
import { escapeHtml as e } from '../core/html.js'

const base = '/manager/storage'
const maximum = 256 * 1024 * 1024
export interface StorageImportWorker { owner: string; available: boolean; reason?: string }
export interface StorageImportTask {
  id: string; phone: string; owner?: string; operation: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'interrupted'
  progress?: { phase?: string }; error?: string
  result?: { restored?: boolean; phone?: string; status?: string; autoConnect?: boolean; connected?: boolean }
}
const terminal = (task?: StorageImportTask) => !!task && ['ready', 'failed', 'interrupted'].includes(task.status)
const safeTask = (task: StorageImportTask, phone: string, owner: string, id?: string) => !!task
  && typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(task.id) && (!id || task.id === id)
  && task.phone === phone && (!task.owner || task.owner === owner) && task.operation === 'restore'
  && ['queued', 'running', 'ready', 'failed', 'interrupted'].includes(task.status)

export function storageImportError(error: unknown): string {
  const code = error instanceof ApiError ? error.code || (error.payload as { error?: string })?.error : typeof error === 'string' ? error : ''
  const messages: Record<string, string> = {
    session_storage_standalone_destination_exists: 'Já existe uma sessão ou dados no destino. Nada foi sobrescrito.',
    session_storage_standalone_identity_invalid: 'O telefone não corresponde à identidade do backup.',
    session_storage_backup_identity_mismatch: 'O telefone não corresponde ao backup selecionado.',
    session_storage_backup_legacy_key_required: 'Este backup antigo exige a chave original configurada no worker. Não informe essa chave no navegador.',
    session_storage_standalone_recovery_required: 'A restauração precisa de conferência no servidor. Não reenvie o arquivo.',
    session_storage_wrong_owner: 'O worker escolhido não pode receber esta sessão. Atualize a lista de destinos.',
    manager_admin_required: 'Entre com um usuário administrador para restaurar a sessão.',
  }
  if (code && messages[code]) return messages[code]
  if (error instanceof ApiError) return `Não foi possível confirmar a restauração${error.status === 413 ? ' (arquivo acima do limite do servidor)' : ''}. Não houve reenvio automático.`
  return error instanceof Error ? error.message : 'Não foi possível confirmar a restauração. Consulte a tarefa antes de repetir.'
}

/** Global SQLite recovery: raw upload, absent destination, never connect or retry a POST. */
export class SessionStorageImport {
  file?: File
  workers: StorageImportWorker[] = []
  phone = ''; owner = ''; busy = false; error = ''; notice = ''; uncertain = false
  task?: StorageImportTask
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
  private polls = 0
  constructor(private readonly api: ApiClient, private readonly render: () => void, private readonly pollLimit = 120) {}

  reset() {
    this.revision++; if (this.timer) clearTimeout(this.timer); this.timer = undefined
    this.file = undefined; this.workers = []; this.phone = ''; this.owner = ''; this.busy = false
    this.error = ''; this.notice = ''; this.uncertain = false; this.task = undefined; this.polls = 0
  }
  blocked() { return this.busy || this.uncertain || !!this.task }
  successPhone() {
    const result = this.task?.result
    return this.task?.status === 'ready' && result?.restored === true && result.phone === this.task.phone && result.status === 'offline' && result.autoConnect === false && result.connected === false ? this.task.phone : ''
  }
  async select(file: File) {
    if (this.blocked()) return
    this.file = file; this.error = ''; this.notice = ''; this.workers = []
    if (!file.name.toLowerCase().endsWith('.viperstorage') || !file.size || file.size > maximum) { this.error = 'Escolha um arquivo .viperstorage não vazio, com até 256 MiB.'; this.render(); return }
    const revision = ++this.revision; this.busy = true; this.render()
    try {
      const result = await this.api.request<{ workers: StorageImportWorker[] }>(`${base}/workers`)
      if (revision !== this.revision) return
      this.workers = (Array.isArray(result?.workers) ? result.workers : []).filter(worker => /^[A-Za-z0-9_-]{1,80}$/.test(worker?.owner || ''))
      if (!this.workers.some(worker => worker.available === true)) this.error = 'Nenhum worker SQLite está disponível. Confira o volume persistente no servidor de destino.'
    } catch (error) { if (revision === this.revision) this.error = storageImportError(error) }
    finally { if (revision === this.revision) { this.busy = false; this.render() } }
  }
  async submit(data: FormData) {
    if (this.blocked()) return
    this.error = ''; this.notice = ''; this.phone = String(data.get('phone') || '').trim(); this.owner = String(data.get('owner') || '')
    const file = this.file
    if (!file || !file.name.toLowerCase().endsWith('.viperstorage') || !file.size || file.size > maximum) { this.error = 'Selecione um arquivo .viperstorage de até 256 MiB.'; this.render(); return }
    if (!/^[1-9]\d{7,14}$/.test(this.phone)) { this.error = 'Informe o telefone da sessão somente com DDI, DDD e número.'; this.render(); return }
    if (!this.workers.some(worker => worker.owner === this.owner && worker.available === true)) { this.error = 'Selecione um worker de destino disponível.'; this.render(); return }
    if (data.get('confirmOriginOffline') !== 'on') { this.error = 'Confirme que a origem está parada e não será reconectada.'; this.render(); return }
    const revision = this.revision, phone = this.phone, owner = this.owner
    const query = new URLSearchParams({ phone, owner, confirmOriginOffline: 'true', mode: 'offline' })
    this.busy = true; this.render()
    try {
      const task = await this.api.request<StorageImportTask>(`${base}/restore-upload?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      if (revision !== this.revision) return
      if (!safeTask(task, phone, owner)) throw new Error('O servidor não confirmou uma tarefa válida. Não reenvie o arquivo; confira o destino.')
      this.task = task; this.file = undefined; this.polls = 0; this.adopt(task)
    } catch (error) {
      if (revision !== this.revision) return
      // A connection failure can hide an accepted upload. Keep the form locked;
      // closing/reopening it must not silently authorize a second submission.
      this.uncertain = !(error instanceof ApiError && error.status >= 400 && error.status < 500)
      this.error = `${storageImportError(error)}${this.uncertain ? ' Resultado incerto: confira o servidor antes de reenviar.' : ''}`
    } finally { if (revision === this.revision) { this.busy = false; this.render() } }
    this.schedule()
  }
  private adopt(task: StorageImportTask) {
    this.notice = ''
    if (task.status === 'failed' || task.status === 'interrupted') { this.error = storageImportError(task.error || ''); return }
    if (task.status === 'ready') {
      if (!this.successPhone()) { this.error = 'O worker não confirmou o estado offline. Não conecte nem reenvie o arquivo sem conferir o destino.'; return }
      this.notice = 'Sessão restaurada e mantida offline. Revise as configurações e o token antes de conectar manualmente.'
    } else this.notice = 'Arquivo recebido. Aguarde a validação e a restauração; a sessão não será conectada automaticamente.'
  }
  private schedule() {
    if (!this.task || terminal(this.task) || this.timer || this.polls >= this.pollLimit) return
    const revision = this.revision
    this.timer = setTimeout(() => { this.timer = undefined; if (revision === this.revision) void this.check() }, 2000)
  }
  async check() {
    if (!this.task || this.busy) return
    if (this.timer) clearTimeout(this.timer); this.timer = undefined
    const revision = this.revision, task = this.task; this.busy = true; this.polls++
    try {
      const next = await this.api.request<StorageImportTask>(`${base}/restores/${encodeURIComponent(task.phone)}/${encodeURIComponent(task.id)}`)
      if (revision !== this.revision) return
      if (!safeTask(next, task.phone, this.owner, task.id)) throw new Error('A consulta não corresponde à tarefa desta restauração.')
      this.task = next; this.error = ''; this.adopt(next)
    } catch (error) { if (revision === this.revision) this.error = `${storageImportError(error)} Use Consultar restauração; não envie o arquivo novamente.`; return }
    finally { if (revision === this.revision) { this.busy = false; this.render() } }
    this.schedule()
  }
  html() {
    if (this.task || this.uncertain) {
      return `<div class="stack">${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}${this.notice ? `<p role="status">${e(this.notice)}</p>` : ''}${this.task ? `<p class="muted">${e(this.task.phone)} · ${e(this.owner)} · ${terminal(this.task) ? this.task.status === 'ready' ? 'Validação concluída' : 'Operação não concluída' : 'Restaurando…'}</p><button class="btn btn--ghost" type="button" data-action="transfer-sqlite-check"${this.busy ? ' disabled' : ''}>Consultar restauração</button>` : ''}${this.successPhone() ? `<button class="btn" type="button" data-action="transfer-view-restored" data-id="${e(this.successPhone())}">Gerenciar sessão restaurada</button><button class="btn btn--ghost" type="button" data-action="transfer-sqlite-another">Restaurar outra sessão</button>` : ''}</div>`
    }
    return `<form class="stack" data-form="transfer-sqlite-restore"><p>Restaure esta sessão em um destino vazio. Ela permanecerá offline; nenhum envio ou conexão será solicitado.</p><p class="muted">Arquivo: <strong>${e(this.file?.name || '')}</strong> · até 256 MiB. O backup contém credenciais: mantenha-o privado.</p><label class="field"><span>Telefone da sessão</span><input name="phone" inputmode="numeric" pattern="[1-9][0-9]{7,14}" value="${e(this.phone)}" placeholder="DDI + DDD + número" required${this.busy ? ' disabled' : ''}></label><label class="field"><span>Worker de destino</span><select name="owner" required${this.busy ? ' disabled' : ''}><option value="">${this.busy ? 'Consultando workers…' : 'Selecione o worker'}</option>${this.workers.map(worker => `<option value="${e(worker.owner)}"${worker.owner === this.owner ? ' selected' : ''}${worker.available === true ? '' : ' disabled'}>${e(worker.owner)}${worker.available === true ? '' : ' — indisponível'}</option>`).join('')}</select></label>${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}<label><input type="checkbox" name="confirmOriginOffline" required${this.busy ? ' disabled' : ''}>Confirmo que a origem está parada e não será reconectada. Restaurar somente offline, sem sobrescrever sessões existentes.</label><p class="muted">Novos backups não pedem senha. Backups antigos exigem a chave original configurada no worker, nunca no navegador.</p><button class="btn"${this.busy || !this.workers.some(worker => worker.available === true) ? ' disabled' : ''}>${this.busy ? 'Aguarde…' : 'Restaurar sessão offline'}</button></form>`
  }
}
