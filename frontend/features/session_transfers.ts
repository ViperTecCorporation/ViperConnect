import { ApiClient } from '../core/api.js'
import { escapeHtml as e } from '../core/html.js'
import { renderModal } from '../components/modal.js'
import { renderMobileBackup, downloadMobileBackup, mobileBackupError, type BackupTaskView } from './mobile_backup.js'

const base = '/manager/session-transfers'
const button = (label: string, action: string, id = '') => `<button type="button" class="btn btn--ghost" data-action="transfer-${action}" data-id="${e(id)}">${e(label)}</button>`
export class SessionTransfersPanel {
  modal?: 'backup' | 'restore' | 'remove'
  phone = ''; busy = false; error = ''; notice = ''; eligible = false
  tasks: BackupTaskView[] = []
  file?: { archive: string; fileName: string }
  private generation = 0
  constructor(private api: ApiClient, private render: () => void) {}
  reset() { this.generation++; this.modal = undefined; this.phone = ''; this.busy = false; this.error = ''; this.notice = ''; this.tasks = []; this.file = undefined; this.eligible = false }
  async refresh() {
    const generation = this.generation
    try {
      const result = await this.api.request<{ tasks: BackupTaskView[] }>(base + '/backups')
      if (generation === this.generation) this.tasks = result.tasks || []
    } catch { /* Do not interrupt session management on a notification read failure. */ }
  }
  async action(action: string, id: string) {
    if (this.busy) return
    const generation = this.generation
    this.error = ''
    if (action === 'transfer-close') { this.modal = undefined; this.file = undefined; this.render(); return }
    if (action === 'transfer-retry-download' && this.file) { try { downloadMobileBackup(this.file) } catch { this.error = 'Verifique as permissões de download do navegador.' } this.render(); return }
    this.file = undefined
    if (action === 'transfer-refresh') { await this.refresh(); this.render(); return }
    this.phone = id; this.eligible = false
    if (action === 'transfer-restore') this.modal = 'restore'
    else if (action === 'transfer-open') {
      this.modal = 'backup'
      this.busy = true; this.render()
      try {
        const result = await this.api.request<{ eligible: boolean }>(`${base}/${encodeURIComponent(id)}/transfer-removal`)
        if (generation === this.generation && this.phone === id) this.eligible = result.eligible
      } catch { /* Unsupported sessions never gain removal eligibility. */ }
      finally { if (generation === this.generation) this.busy = false }
    } else if (action === 'transfer-remove') this.modal = 'remove'
    else if (action === 'transfer-download') {
      const task = this.tasks.find(task => task.deviceId === id && task.status === 'ready')
      if (!task) return
      this.modal = 'backup'; this.busy = true; this.render()
      try {
        const file = await this.api.request<{ archive: string; fileName: string }>(`${base}/${encodeURIComponent(id)}/backup-tasks/${encodeURIComponent(task.id)}/download`)
        if (generation !== this.generation) return
        this.file = file
        try { downloadMobileBackup(file) } catch { this.error = 'O arquivo está pronto. Clique em baixar novamente.' }
      } catch { if (generation === this.generation) this.error = 'Arquivo indisponível ou expirado. Atualize os backups.' }
      finally { if (generation === this.generation) this.busy = false }
    }
    if (generation === this.generation) this.render()
  }
  async submit(form: string, data: FormData) {
    if (this.busy) return
    if (typeof data.get('phone') === 'string') data.set('phone', String(data.get('phone')).trim())
    const generation = this.generation, phone = this.phone
    this.error = ''; this.busy = true; this.render()
    try {
      if (form === 'transfer-remove') {
        if (data.get('confirm') !== 'on' || data.get('backupValidated') !== 'on' || data.get('phone') !== phone || !data.get('password')) throw new Error('Confirme a validação no destino, o telefone e a senha do administrador.')
        await this.api.request(`${base}/${encodeURIComponent(phone)}/transfer-removal`, { method: 'DELETE', body: JSON.stringify({ phone, password: String(data.get('password')), confirm: true, backupValidated: true }) })
      } else {
        const password = String(data.get('password') || '')
        if (password.length < 12 || password.length > 128 || data.get('confirm') !== 'on') throw new Error('Informe a senha de 12 a 128 caracteres e confirme a suspensão da origem.')
        if (form === 'transfer-restore') {
          const file = data.get('archive')
          if (!(file instanceof Blob) || !file.size || file.size > 16 * 1024 * 1024) throw new Error('Selecione um arquivo .vipersession de até 16 MiB.')
          const result = await this.api.request<{ warning?: string }>(base + '/restore', { method: 'POST', body: JSON.stringify({ archive: await file.text(), password, confirmOriginOffline: true }) })
          this.notice = result?.warning ? 'Sessão restaurada. Não foi possível solicitar a conexão ao worker; use Conectar. Não importe novamente.' : 'Sessão restaurada com conexão automática habilitada. Conexão solicitada ao worker.'
        } else {
          if (password !== data.get('passwordConfirmation')) throw new Error('As senhas não coincidem.')
          const task = await this.api.request<BackupTaskView>(`${base}/${encodeURIComponent(phone)}/backup-tasks`, { method: 'POST', body: JSON.stringify({ password, confirmSuspend: true, mode: String(data.get('mode') || 'complete') }) })
          if (generation === this.generation) this.tasks = [...this.tasks.filter(t => t.deviceId !== phone), task]
        }
      }
      if (generation !== this.generation) return
      this.notice = form === 'transfer-restore' ? this.notice : form === 'transfer-remove' ? 'Sessão removida apenas desta instância. Nenhum logout remoto foi solicitado.' : 'Backup solicitado. Você pode sair da página; acompanhe o resultado abaixo.'
      this.modal = undefined; this.file = undefined
    } catch (error) { if (generation === this.generation) this.error = mobileBackupError(error) }
    finally { if (generation === this.generation) { this.busy = false; this.render() } }
  }
  html() {
    return `<section class="mobile-overview__section"><div class="mobile-overview__status"><h3>Backups de sessões</h3><div class="mobile-overview__actions">${button('Restaurar sessão', 'restore')}${button('Atualizar', 'refresh')}</div></div>${this.notice ? `<p role="status">${e(this.notice)}</p>` : ''}${this.error && !this.modal ? `<p role="alert">${e(this.error)}</p>` : ''}${!this.tasks.length ? '<p class="muted">Nenhum backup solicitado. Em Gerenciar → Visão geral, escolha Backup e migração.</p>' : this.tasks.map(task => `<div class="mobile-overview__status"><div><strong>${e(task.deviceId)}</strong><p role="status">${e(task.status === 'ready' ? `Disponível até ${new Date(task.expiresAt).toLocaleString('pt-BR')}` : task.status === 'running' ? 'Gerando em segundo plano…' : task.status === 'interrupted' ? 'Interrompido. Consulte a conexão antes de tentar novamente.' : 'Não foi possível gerar o backup. Verifique se a sessão Zapo está registrada e usa Redis.')}</p></div>${task.status === 'ready' ? button('Baixar .vipersession', 'download', task.deviceId) : ''}</div>`).join('')}</section>`
  }
  dialog() {
    if (!this.modal) return ''
    let content: string
    if (this.file) content = `<div class="stack"><p role="status">Arquivo pronto. Confira o download antes de fechar.</p><strong>${e(this.file.fileName)}</strong>${button('Baixar novamente', 'retry-download')}${button('Fechar', 'close')}</div>`
    else if (this.modal === 'remove') content = `<form class="mobile-removal" data-form="transfer-remove"><div class="mobile-removal__warning" role="alert"><strong>O backup foi validado no novo servidor?</strong><p>Confirme a restauração, conexão e funcionamento no destino. Esta ação remove somente as credenciais e o cadastro locais, sem logout remoto.</p></div><label class="field"><span>Digite ${e(this.phone)}</span><input name="phone" inputmode="numeric" autocomplete="off" required></label><label class="field"><span>Senha do administrador conectado</span><input type="password" name="password" autocomplete="current-password" required></label><div class="mobile-removal__checks"><label><input type="checkbox" name="backupValidated" required><span>Restaurei e validei o backup no novo servidor.</span></label><label><input type="checkbox" name="confirm" required><span>Confirmo a remoção definitiva desta instância.</span></label></div><div class="mobile-removal__actions"><button class="btn btn--danger" ${this.busy ? 'disabled' : ''}>Remover desta instância</button></div></form>`
    else content = renderMobileBackup(this.modal === 'restore', this.busy).split('.viperdevice').join('.vipersession').split('dispositivo').join('sessão').replace('data-form="mobile-', 'data-form="transfer-') + (this.modal === 'backup' && this.eligible ? `<hr>${button('Remover desta instância após migração', 'remove', this.phone)}` : '')
    return renderModal('session-transfer', this.modal === 'restore' ? 'Restaurar sessão' : this.modal === 'remove' ? 'Remover sessão desta instância' : 'Backup e migração da sessão', `${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}${content}`, { subtitle: this.phone }).replace('data-close-modal', `data-action="transfer-close" ${this.busy ? 'disabled' : ''}`)
  }
}
